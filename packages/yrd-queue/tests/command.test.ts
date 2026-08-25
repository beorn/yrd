/**
 * @failure Git-backed Queue steps can check one candidate and merge another or lose durable command evidence.
 * @level l2
 * @consumer @yrd/queue Git step adapters
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveRelativeSubmoduleOrigin } from "git-super/submodule-origin"
import {
  createBayJobDefs,
  currentChangeRev,
  changeAdmission,
  changeDeliveryState,
  withBays,
  type BayWorkspace,
  type Change,
} from "@yrd/bay"
import { createFailure, createMemoryJournal, createYrd, createYrdDef, failureFact, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess, shellCommand, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import * as z from "zod"
import {
  CommandEvidenceSchema,
  CommandTerminalSchema,
  DIAGNOSTICS_COMPARISON_READY,
  GitCheckEvidenceSchema,
  GitCheckResultEvidenceSchema,
  IntegrationProofSchema,
  configuredCommandStep,
  configuredMergeStep,
  createGitChangeRemerger,
  findRepositoryChangeMerge,
  findRepositoryMergeRecords,
  CANDIDATE_REF_NAMESPACE,
  candidateRefFor,
  gitCandidatePreparer,
  gitCheckStep,
  gitMergeStep,
  gitMergeRecorder,
  inspectGitQueueTarget,
  ChangeSnapshotSchema,
  Queues,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type GitCheckEvidence,
  type GitCheckResultEvidence,
  type ChangeShape,
  type RefusePathsPolicy,
  type StepExecution,
} from "@yrd/queue"

const roots: string[] = []
const runtime = { runner: "local", leaseMs: 60_000 }
const gitFetchTimeout = {
  exitCode: 124,
  signal: "SIGTERM",
  stdout: "",
  stderr: "",
  durationMs: 30_000,
  timedOut: true,
  verdict: "TIMED_OUT",
} satisfies ProcessResult
const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`
type Checked = AddStepResult<ChangeShape, "check", GitCheckResultEvidence>

function expectNonInteractiveRebases(commands: readonly (readonly string[])[]): void {
  const editorCapable = commands.filter((command) => !command.includes("--abort"))
  expect(editorCapable.length).toBeGreaterThan(0)
  for (const command of editorCapable) {
    const rebase = command.indexOf("rebase")
    expect(rebase).toBeGreaterThan(1)
    expect(command.slice(rebase - 2, rebase + 1), command.join(" ")).toEqual(["-c", "core.editor=true", "rebase"])
  }
}

function changeFacts(pr: Change | undefined) {
  if (pr === undefined) throw new Error("expected PR")
  const revision = currentChangeRev(pr)
  return {
    ...pr,
    status: changeDeliveryState(pr),
    revision: revision.n,
    headSha: revision.head,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function stablePatchId(
  repo: string,
  from: string,
  to: string,
  pathspec: readonly string[] = [],
): Promise<string> {
  const output =
    await Bun.$`git -C ${repo} diff --no-ext-diff --no-textconv --ignore-submodules=none --no-renames --full-index --binary ${from} ${to} -- ${pathspec} | git -C ${repo} patch-id --stable`.text()
  const patchId = /^([0-9a-f]{40,64})\s+[0-9a-f]{40,64}$/iu.exec(output.trim())?.[1]
  if (patchId === undefined) throw new Error(`expected stable patch id for ${from}..${to}`)
  return patchId
}

async function queueBaseSha(repo: string, base: string): Promise<string> {
  try {
    return await git(repo, ["rev-parse", "--verify", `refs/remotes/origin/${base}`])
  } catch {
    return git(repo, ["rev-parse", "--verify", `refs/heads/${base}`])
  }
}

async function repository<const Names extends readonly string[]>(
  ...names: Names
): Promise<{ repo: string } & Record<Names[number], string>> {
  const root = await mkdtemp(join(tmpdir(), "yrd-queue-git-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  const shas: Record<string, string> = {}
  for (const name of names) {
    await git(repo, ["switch", "-qc", `issue/${name}`])
    await writeFile(join(repo, `${name}.txt`), `${name}\n`)
    await git(repo, ["add", `${name}.txt`])
    await git(repo, ["commit", "-qm", name])
    shas[name] = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
  }
  return { repo, ...shas } as { repo: string } & Record<Names[number], string>
}

async function hookedSubmoduleRepository(options: {
  baseVersion: string
  candidateVersion: string
  requiredVersion: string
  splitCarrier?: boolean
  /** Put the candidate module commit on a side branch instead of the module's
   * main. Since the (b) fill-in, an authored gitlink whose floor is ON its
   * submodule's main COMPOSES (the queue writes the shaset from main), so
   * refusal-path tests need a floor that is genuinely not on main. */
  candidateOffMain?: boolean
  /** Which halves of the coupled unit the carrier actually carries.
   *
   * Default (undefined) is `"both"` and is byte-identical to this fixture's
   * long-standing behaviour: the gitlink bump and the root consumer ride
   * together. `"pin-only"` and `"code-only"` exist so a gate that reads BOTH
   * halves can be shown to REFUSE when either is missing — the "where either
   * half alone is red" arm of @i/10-merge-queue/coupled-pin-and-code, which no
   * test expressed before. Merge green is not the claim; merge green under
   * a gate that could have failed is. */
  carry?: "both" | "pin-only" | "code-only"
}): Promise<{ repo: string; remote: string; baseSha: string; featureSha: string; moduleSha: string }> {
  const { repo } = await repository()
  const module = join(repo, "..", "module")
  await Bun.$`git init -q -b main ${module}`
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(module, "version.txt"), `${options.baseVersion}\n`)
  await git(module, ["add", "version.txt"])
  await git(module, ["commit", "-qm", "base"])
  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dependency"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])

  if (options.candidateOffMain === true) await git(module, ["switch", "-qc", "side"])
  await writeFile(join(module, "version.txt"), `${options.candidateVersion}\n`)
  await git(module, ["commit", "-qam", "candidate"])
  const moduleSha = await git(module, ["rev-parse", "HEAD"])
  if (options.candidateOffMain === true) await git(module, ["switch", "-q", "main"])
  await git(repo, ["switch", "-qc", "issue/feature"])
  const carry = options.carry ?? "both"
  if (carry !== "code-only") {
    await git(join(repo, "dep"), ["fetch", "-q", "origin"])
    await git(join(repo, "dep"), ["checkout", "-q", moduleSha])
    await git(repo, ["add", "dep"])
    if (options.splitCarrier === true) await git(repo, ["commit", "-qm", "feature dependency"])
  }
  if (carry === "pin-only") {
    // splitCarrier already committed the gitlink above; without it the gitlink
    // is still staged and this is the commit that carries it. Committing twice
    // would fail on an empty index rather than produce a pin-only carrier.
    // Named for what it is rather than reusing "feature", which would make a
    // pin-only carrier read like a coupled one in any log-based assertion.
    if (options.splitCarrier !== true) await git(repo, ["commit", "-qm", "feature dependency"])
  } else {
    await writeFile(join(repo, "feature.txt"), "feature\n")
    await git(repo, ["add", "feature.txt"])
    await git(repo, ["commit", "-qm", "feature"])
  }
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["submodule", "update", "--init", "--recursive"])

  const remote = join(repo, "..", "origin.git")
  await Bun.$`git init -q --bare ${remote}`
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
  const hook = join(repo, ".git", "hooks", "pre-push")
  await writeFile(
    hook,
    `#!/bin/sh\nroot=$(git rev-parse --show-toplevel)\ntest "$(cat "$root/dep/version.txt")" = ${options.requiredVersion}\n`,
  )
  await chmod(hook, 0o755)
  return { repo, remote, baseSha, featureSha, moduleSha }
}

async function submoduleMainMergeRepository(
  options: Readonly<{ pushSuccessor?: boolean; nonBareComponentOrigin?: boolean }> = {},
): Promise<{
  repo: string
  submodule: string
  rootRemote: string
  submoduleRemote: string
  rootBaseSha: string
  submoduleBaseSha: string
  pinSha: string
  successorSha: string
  featureSha: string
}> {
  const { repo } = await repository()
  const submodule = join(repo, "..", "submodule")
  const bareSubmoduleRemote = join(repo, "..", "component-origin.git")
  await Bun.$`git init -q -b main ${submodule}`
  await git(submodule, ["config", "user.name", "Yrd Test"])
  await git(submodule, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(submodule, "version.txt"), "base\n")
  await git(submodule, ["add", "version.txt"])
  await git(submodule, ["commit", "-qm", "base"])
  const submoduleBaseSha = await git(submodule, ["rev-parse", "HEAD"])
  await Bun.$`git init -q --bare -b main ${bareSubmoduleRemote}`
  await git(submodule, ["remote", "add", "origin", bareSubmoduleRemote])
  await git(submodule, ["push", "-q", "origin", "main"])
  const submoduleRemote = options.nonBareComponentOrigin === true ? submodule : bareSubmoduleRemote

  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleRemote, "dep"])
  await git(repo, ["commit", "-qam", "add dependency"])
  const rootBaseSha = await git(repo, ["rev-parse", "HEAD"])
  const rootRemote = join(repo, "..", "root-origin.git")
  await Bun.$`git init -q --bare ${rootRemote}`
  await git(repo, ["remote", "add", "origin", rootRemote])
  await git(repo, ["push", "-q", "origin", "main"])

  await git(submodule, ["switch", "-qc", "task/submodule"])
  await writeFile(join(submodule, "version.txt"), "pin\n")
  await git(submodule, ["commit", "-qam", "pin"])
  const pinSha = await git(submodule, ["rev-parse", "HEAD"])
  await git(submodule, ["push", "-q", "origin", "task/submodule"])
  if (options.nonBareComponentOrigin === true) await git(submodule, ["switch", "-q", "main"])

  await git(repo, ["switch", "-qc", "issue/feature"])
  await git(join(repo, "dep"), ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await git(join(repo, "dep"), ["checkout", "-q", pinSha])
  await git(repo, ["add", "dep"])
  await git(repo, ["commit", "-qm", "pin dependency"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["push", "-q", "origin", "issue/feature"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "update", "-q"])

  let successorSha = pinSha
  if (options.pushSuccessor === true) {
    // The submit-time publication guard has already observed pinSha on this
    // branch. Preserve the disputed timeline as an explicit falsification:
    // an ordinary fast-forward successor still contains the earlier pin.
    await writeFile(join(submodule, "version.txt"), "successor\n")
    await git(submodule, ["commit", "-qam", "successor"])
    successorSha = await git(submodule, ["rev-parse", "HEAD"])
    await git(submodule, ["push", "-q", "origin", "task/submodule"])
  }
  await git(join(repo, "dep"), ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])

  return {
    repo,
    submodule,
    rootRemote,
    submoduleRemote,
    rootBaseSha,
    submoduleBaseSha,
    pinSha,
    successorSha,
    featureSha,
  }
}

async function multiSubmoduleMainMergeRepository(): Promise<{
  repo: string
  rootRemote: string
  rootBaseSha: string
  featureSha: string
  submodules: readonly Readonly<{
    path: string
    remote: string
    baseSha: string
    pinSha: string
  }>[]
}> {
  const { repo } = await repository()
  await git(repo, ["config", "protocol.file.allow", "always"])
  const submodules: Array<{ path: string; remote: string; baseSha: string; pinSha: string; worktree: string }> = []

  for (const name of ["a", "b"]) {
    const path = `dep-${name}`
    const worktree = join(repo, "..", `component-${name}`)
    const remote = join(repo, "..", `component-${name}-origin.git`)
    await Bun.$`git init -q -b main ${worktree}`
    await git(worktree, ["config", "user.name", "Yrd Test"])
    await git(worktree, ["config", "user.email", "yrd@example.invalid"])
    await writeFile(join(worktree, "version.txt"), `base-${name}\n`)
    await git(worktree, ["add", "version.txt"])
    await git(worktree, ["commit", "-qm", `base ${name}`])
    const baseSha = await git(worktree, ["rev-parse", "HEAD"])
    // `git submodule add` follows the bare origin's HEAD, so make the fixture's
    // intended branch explicit instead of inheriting the host Git default.
    await Bun.$`git init -q --bare -b main ${remote}`
    await git(worktree, ["remote", "add", "origin", remote])
    await git(worktree, ["push", "-q", "origin", "main"])
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", remote, path])
    submodules.push({ path, remote, baseSha, pinSha: baseSha, worktree })
  }
  await git(repo, ["commit", "-qm", "add dependencies"])
  const rootBaseSha = await git(repo, ["rev-parse", "HEAD"])
  const rootRemote = join(repo, "..", "multi-root-origin.git")
  await Bun.$`git init -q --bare ${rootRemote}`
  await git(repo, ["remote", "add", "origin", rootRemote])
  await git(repo, ["push", "-q", "origin", "main"])

  for (const submodule of submodules) {
    await git(submodule.worktree, ["switch", "-qc", `task/${submodule.path}`])
    await writeFile(join(submodule.worktree, "version.txt"), `pin-${submodule.path}\n`)
    await git(submodule.worktree, ["commit", "-qam", `pin ${submodule.path}`])
    submodule.pinSha = await git(submodule.worktree, ["rev-parse", "HEAD"])
    await git(submodule.worktree, ["push", "-q", "origin", `task/${submodule.path}`])
  }

  await git(repo, ["switch", "-qc", "issue/feature"])
  for (const submodule of submodules) {
    const checkout = join(repo, submodule.path)
    await git(checkout, ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await git(checkout, ["checkout", "-q", submodule.pinSha])
    await git(repo, ["add", submodule.path])
  }
  await git(repo, ["commit", "-qm", "pin dependencies"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["push", "-q", "origin", "issue/feature"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "update", "-q"])

  return {
    repo,
    rootRemote,
    rootBaseSha,
    featureSha,
    submodules: submodules.map(({ path, remote, baseSha, pinSha }) => ({ path, remote, baseSha, pinSha })),
  }
}

async function restackSubmoduleRepository(
  options: Readonly<{
    sourcePath?: string
    sourceDelete?: boolean
    sourceRenameTo?: string
    upstreamPath?: string
  }> = {},
): Promise<{
  repo: string
  module: string
  oldPinSha: string
  newPinSha: string
  sourceTipSha: string
  rootBaseSha: string
}> {
  const { repo } = await repository()
  const module = join(repo, "..", "module")
  await Bun.$`git init -q -b main ${module}`
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  const sourcePath = options.sourcePath ?? "src/candidate.ts"
  await writeFile(join(module, "README.md"), "base\n")
  if (options.sourceDelete === true || options.sourceRenameTo !== undefined) {
    await mkdir(dirname(join(module, sourcePath)), { recursive: true })
    await writeFile(join(module, sourcePath), "export const original = true\n")
  }
  await git(module, ["add", "."])
  await git(module, ["commit", "-qm", "base"])
  const oldPinSha = await git(module, ["rev-parse", "HEAD"])

  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dependency"])

  await git(module, ["switch", "-qc", "issue/source"])
  if (options.sourceRenameTo !== undefined) {
    await mkdir(dirname(join(module, options.sourceRenameTo)), { recursive: true })
    await git(module, ["mv", sourcePath, options.sourceRenameTo])
  } else if (options.sourceDelete === true) {
    await rm(join(module, sourcePath))
    await git(module, ["add", "-u", sourcePath])
  } else {
    await mkdir(dirname(join(module, sourcePath)), { recursive: true })
    await writeFile(join(module, sourcePath), "export const candidate = true\n")
    await git(module, ["add", sourcePath])
  }
  await git(module, ["commit", "-qm", "candidate payload"])
  const sourceTipSha = await git(module, ["rev-parse", "HEAD"])

  await git(module, ["switch", "-q", "main"])
  const upstreamPath = options.upstreamPath ?? "src/upstream.ts"
  await mkdir(dirname(join(module, upstreamPath)), { recursive: true })
  await writeFile(join(module, upstreamPath), "export const upstream = true\n")
  await git(module, ["add", upstreamPath])
  await git(module, ["commit", "-qm", "upstream payload"])
  const newPinSha = await git(module, ["rev-parse", "HEAD"])

  await git(join(repo, "dep"), ["fetch", "-q", "origin"])
  await git(join(repo, "dep"), ["checkout", "-q", newPinSha])
  await git(repo, ["add", "dep"])
  await git(repo, ["commit", "-qm", "advance dependency"])
  const rootBaseSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["branch", "issue/source", rootBaseSha])
  return { repo, module, oldPinSha, newPinSha, sourceTipSha, rootBaseSha }
}

async function groupedSubmoduleRepository(): Promise<{
  repo: string
  remote: string
  featureSha: string
  origin: string
  pins: readonly [string, string]
}> {
  const { repo } = await repository()
  const origin = join(repo, "..", "grouped-module")
  await Bun.$`git init -q -b main ${origin}`
  await git(origin, ["config", "user.name", "Yrd Test"])
  await git(origin, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(origin, "version.txt"), "base\n")
  await git(origin, ["add", "version.txt"])
  await git(origin, ["commit", "-qm", "base"])
  const submoduleBase = await git(origin, ["rev-parse", "HEAD"])

  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "dep-a"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "dep-b"])
  await git(repo, ["commit", "-qm", "add grouped dependencies"])

  await writeFile(join(origin, "version.txt"), "one\n")
  await git(origin, ["commit", "-qam", "one"])
  const first = await git(origin, ["rev-parse", "HEAD"])
  await writeFile(join(origin, "version.txt"), "two\n")
  await git(origin, ["commit", "-qam", "two"])
  const second = await git(origin, ["rev-parse", "HEAD"])
  await git(origin, ["branch", "pin-first", first])
  await git(origin, ["branch", "pin-second", second])
  await git(origin, ["switch", "-q", "--detach", submoduleBase])
  await git(origin, ["branch", "-f", "main", submoduleBase])

  await git(repo, ["switch", "-qc", "issue/feature"])
  for (const [path, sha] of [
    // Deliberately put the descendant first in path order. Promotion planning
    // must recognize that dep-b's older pin is already covered by dep-a's
    // target instead of falsely calling the same-origin chain divergent.
    ["dep-a", second],
    ["dep-b", first],
  ] as const) {
    await git(join(repo, path), ["fetch", "-q", "origin"])
    await git(join(repo, path), ["checkout", "-q", sha])
  }
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "dep-a", "dep-b", "feature.txt"])
  await git(repo, ["commit", "-qm", "grouped feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["submodule", "update", "--init", "--recursive"])

  const remote = join(repo, "..", "origin.git")
  await Bun.$`git init -q --bare ${remote}`
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
  return { repo, remote, featureSha, origin, pins: [first, second] }
}

const payloadLines = (five: string, three = "3"): string =>
  `${["1", "2", three, "4", five, "6", "7", "8", "9", "10"].join("\n")}\n`

/**
 * A plain (non-submodule) repository whose reviewed head changes one line in the
 * middle of `payload.txt`. Returned `baseSha` is the base the reviewed head was cut
 * from; callers advance `main` afterwards to exercise the recut base-chase gate.
 */
async function directRemergeBaseChaseRepository(): Promise<{ repo: string; baseSha: string; featureSha: string }> {
  const { repo } = await repository()
  await writeFile(join(repo, "payload.txt"), payloadLines("5"))
  await git(repo, ["add", "payload.txt"])
  await git(repo, ["commit", "-qm", "payload base"])
  const baseSha = await git(repo, ["rev-parse", "main"])
  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "payload.txt"), payloadLines("FIVE"))
  await git(repo, ["commit", "-qam", "reviewed change on line five"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, baseSha, featureSha }
}

type CodeCarrierProposalFixture = Readonly<{
  repo: string
  approvedBaseSha: string
  approvedSha: string
  currentBaseSha: string
  exact: Readonly<{ ref: string; sha: string }>
  drop: Readonly<{ ref: string; sha: string }>
  extra: Readonly<{ ref: string; sha: string }>
  corrupt: Readonly<{ ref: string; sha: string }>
  whitespace: Readonly<{ ref: string; sha: string }>
  mode: Readonly<{ ref: string; sha: string }>
  symlink: Readonly<{ ref: string; sha: string }>
  uncontained: Readonly<{ ref: string; sha: string }>
  sibling: Readonly<{ ref: string; sha: string }>
  repaired: Readonly<{ ref: string; sha: string }>
  gitlinkAdd: Readonly<{ ref: string; sha: string }>
  gitlinkModify: Readonly<{ ref: string; sha: string }>
  gitlinkDelete: Readonly<{ ref: string; sha: string }>
}>

/** P1a proposals are independently authored carrier refs, not queue-generated
 * replays. The approved range has two commits; every proposal has one. */
async function codeCarrierProposalRepository(): Promise<CodeCarrierProposalFixture> {
  const { repo } = await repository()
  const initialSha = await git(repo, ["rev-parse", "main"])
  await writeFile(
    join(repo, ".gitmodules"),
    [
      '[submodule "dep"]',
      "\tpath = dep",
      `\turl = ${repo}`,
      '[submodule "dep-added"]',
      "\tpath = dep-added",
      `\turl = ${repo}`,
      "",
    ].join("\n"),
  )
  await git(repo, ["add", ".gitmodules"])
  await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${initialSha},dep`])
  await git(repo, ["commit", "-qm", "baseline gitlink"])
  const approvedBaseSha = await git(repo, ["rev-parse", "main"])
  await git(repo, ["switch", "-qc", "issue/approved"])
  await writeFile(join(repo, "approved-a.txt"), "approved a\n")
  await git(repo, ["add", "approved-a.txt"])
  await git(repo, ["commit", "-qm", "approved part a"])
  await writeFile(join(repo, "approved-b.txt"), "approved b\n")
  await git(repo, ["add", "approved-b.txt"])
  await git(repo, ["commit", "-qm", "approved part b"])
  const approvedSha = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-q", "main"])
  await writeFile(join(repo, "authority.txt"), "current authority\n")
  await git(repo, ["add", "authority.txt"])
  await git(repo, ["commit", "-qm", "advance authority"])
  const currentBaseSha = await git(repo, ["rev-parse", "HEAD"])

  const proposal = async (
    name: string,
    files: Readonly<Record<string, string>>,
    options: Readonly<{
      baseSha?: string
      executable?: string
      symlink?: Readonly<{ path: string; target: string }>
      gitlink?: Readonly<{ action: "add" | "modify" | "delete"; path: string; sha?: string }>
    }> = {},
  ): Promise<Readonly<{ ref: string; sha: string }>> => {
    const branch = `proposal/${name}`
    await git(repo, ["switch", "-qc", branch, options.baseSha ?? currentBaseSha])
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content)
    if (options.executable !== undefined) await chmod(join(repo, options.executable), 0o755)
    if (options.symlink !== undefined) {
      await rm(join(repo, options.symlink.path))
      await symlink(options.symlink.target, join(repo, options.symlink.path))
    }
    await git(repo, ["add", "."])
    if (options.gitlink?.action !== "delete") {
      await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${initialSha},dep`])
    }
    if (options.gitlink?.action === "delete") {
      await git(repo, ["update-index", "--force-remove", options.gitlink.path])
    } else if (options.gitlink !== undefined) {
      await git(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${options.gitlink.sha ?? approvedSha},${options.gitlink.path}`,
      ])
    }
    await git(repo, ["commit", "-qm", `independently authored ${name}`])
    const sha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    return { ref: `refs/heads/${branch}`, sha }
  }
  const approved = { "approved-a.txt": "approved a\n", "approved-b.txt": "approved b\n" }
  return {
    repo,
    approvedBaseSha,
    approvedSha,
    currentBaseSha,
    exact: await proposal("exact", approved),
    drop: await proposal("drop", { "approved-a.txt": "approved a\n" }),
    extra: await proposal("extra", { ...approved, "unapproved-extra.txt": "extra\n" }),
    corrupt: await proposal("corrupt", { ...approved, "approved-a.txt": "corrupt a\n" }),
    whitespace: await proposal("whitespace", { ...approved, "approved-a.txt": "approved a  \n" }),
    mode: await proposal("mode", approved, { executable: "approved-a.txt" }),
    symlink: await proposal("symlink", approved, {
      symlink: { path: "approved-a.txt", target: "approved a" },
    }),
    uncontained: await proposal("uncontained", approved, { baseSha: approvedBaseSha }),
    sibling: await proposal("sibling", approved),
    repaired: await proposal("repaired", approved),
    gitlinkAdd: await proposal("gitlink-add", approved, {
      gitlink: { action: "add", path: "dep-added" },
    }),
    gitlinkModify: await proposal("gitlink-modify", approved, {
      gitlink: { action: "modify", path: "dep" },
    }),
    gitlinkDelete: await proposal("gitlink-delete", approved, {
      gitlink: { action: "delete", path: "dep" },
    }),
  }
}

function remergeProposedCodeCarrier(
  remerger: ReturnType<typeof createGitChangeRemerger>,
  input: Parameters<ReturnType<typeof createGitChangeRemerger>["recut"]>[0],
  proposedHeadSha: string,
) {
  // The production input has not grown this P1a seam yet. Keep the RED at
  // runtime so the failure proves replay rather than stopping at transpilation.
  return remerger.recut({ ...input, proposedHeadSha } as Parameters<
    ReturnType<typeof createGitChangeRemerger>["recut"]
  >[0])
}

function observeGitMutations(process: Pick<Process, "run">): {
  process: Pick<Process, "run">
  mutations: string[][]
} {
  const mutations: string[][] = []
  return {
    mutations,
    process: {
      run(request) {
        if (gitInvocationMutates(request.argv)) mutations.push([...request.argv])
        return process.run(request)
      },
    },
  }
}

function gitInvocationMutates(argv: readonly string[]): boolean {
  if (argv[0] !== "git") return false
  let index = 1
  while (index < argv.length) {
    const argument = argv[index]
    if (["-C", "-c", "--config-env", "--git-dir", "--namespace", "--work-tree"].includes(argument ?? "")) {
      index += 2
      continue
    }
    if (argument?.startsWith("-") === true) {
      index += 1
      continue
    }
    break
  }
  const command = argv[index]
  const args = argv.slice(index + 1)
  if (command === undefined) return false
  if (
    [
      "add",
      "am",
      "checkout",
      "checkout-index",
      "cherry-pick",
      "clean",
      "clone",
      "commit",
      "commit-tree",
      "fetch",
      "gc",
      "init",
      "merge",
      "mktree",
      "mv",
      "pack-refs",
      "prune",
      "push",
      "read-tree",
      "rebase",
      "repack",
      "reset",
      "revert",
      "rm",
      "switch",
      "update-index",
      "update-ref",
      "write-tree",
    ].includes(command)
  ) {
    return true
  }
  if (command === "apply") return !args.includes("--check")
  if (command === "hash-object") return args.includes("-w") || args.includes("--literally")
  if (command === "merge-tree") return args.includes("--write-tree")
  if (command === "worktree") {
    return args.some((argument) => ["add", "lock", "move", "prune", "remove", "repair", "unlock"].includes(argument))
  }
  if (command === "notes") {
    return args.some((argument) => ["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(argument))
  }
  if (command === "branch") {
    if (args.length === 0 || args.some((argument) => ["--list", "--show-current"].includes(argument))) return false
    return true
  }
  if (command === "tag") {
    if (args.length === 0 || args.some((argument) => ["-l", "--list", "--verify"].includes(argument))) return false
    return true
  }
  if (command === "replace") return args.length > 0 && !args.includes("--list")
  if (command === "symbolic-ref") {
    return args.includes("--delete") || args.filter((argument) => !argument.startsWith("-")).length > 1
  }
  if (command === "config") {
    return !args.some((argument) =>
      ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"].includes(argument),
    )
  }
  return false
}

const unusedWorkspace: BayWorkspace = {
  revision: "unused-workspace-v1",
  provision: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
  checkpoint: () => ({
    status: "completed",
    conclusion: "failure",
    error: { code: "unused", message: "not used" },
  }),
  deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
}

async function checkedQueue(
  process: Pick<Process, "run">,
  repo: string,
  command: readonly string[],
  options: Readonly<{
    batch?: number
    waiting?: boolean
    checkoutParent?: string
    classification?: "base" | "carrier"
    comparison?: "diagnostics"
    comparisonReady?: string
    mode?: "delta" | "strict"
    env?: NodeJS.ProcessEnv
    environmentOverrides?: Readonly<Record<string, string>>
    environmentPassthrough?: readonly string[]
    refuse?: RefusePathsPolicy
    mergeCommand?: readonly string[]
    prepareCandidate?: boolean
    checkpointIdentity?: string | (() => string)
    defaultSteps?: readonly ("check" | "merge")[]
    log?: ConditionalLogger
    checkpointMigration?: (input: { path: string; candidate: { baseSha: string; candidateSha: string } }) => Promise<{
      version: 1
      manifest: { version: 1; targetIdentity: string; edges: readonly { from: string; to: string }[] }
      hash: string
    }>
  }> = {},
) {
  const bayJobs = createBayJobDefs(unusedWorkspace)
  const check = withStep(
    "check",
    gitCheckStep({
      inject: { process },
      repo,
      command,
      ...(options.classification === undefined ? {} : { classification: options.classification }),
      ...(options.comparison === undefined ? {} : { comparison: options.comparison }),
      ...(options.comparisonReady === undefined ? {} : { comparisonReady: options.comparisonReady }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.waiting ? { runner: "waiting" as const } : {}),
      ...(options.checkoutParent === undefined ? {} : { checkoutParent: options.checkoutParent }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.environmentOverrides === undefined ? {} : { environmentOverrides: options.environmentOverrides }),
      ...(options.environmentPassthrough === undefined
        ? {}
        : { environmentPassthrough: options.environmentPassthrough }),
      ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
      ...(options.checkpointMigration === undefined ? {} : { checkpointMigration: options.checkpointMigration }),
    }),
    {
      revision: `check:${JSON.stringify(command)}:${options.waiting === true}`,
      output: GitCheckResultEvidenceSchema,
      ...(options.classification === undefined ? {} : { classification: options.classification }),
    },
  )
  const merge = withMerge(
    options.mergeCommand === undefined
      ? gitMergeStep<Checked>({
          inject: { process },
          repo,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
          ...(options.checkpointIdentity === undefined ? {} : { checkpointIdentity: options.checkpointIdentity }),
        })
      : configuredMergeStep<Checked>({
          inject: { process },
          repo,
          command: options.mergeCommand,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
          ...(options.checkpointIdentity === undefined ? {} : { checkpointIdentity: options.checkpointIdentity }),
        }),
    { revision: options.mergeCommand === undefined ? "git-merge-v1" : "configured-merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: options.batch ?? 1,
    defaultBase: "main",
    ...(options.defaultSteps === undefined ? {} : { defaultSteps: options.defaultSteps }),
    resolveBaseSha: (base) => queueBaseSha(repo, base),
    ...(options.prepareCandidate === true
      ? { prepareCandidate: gitCandidatePreparer({ inject: { process }, repo }) }
      : {}),
    recordMerge: gitMergeRecorder({ inject: { process }, repo }),
  })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), log: options.log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

type TestQueueApp = Awaited<ReturnType<typeof checkedQueue>>
type CarrierSubmissionApp = Pick<TestQueueApp, "bays" | "state">
type CarrierSubmission = Readonly<{
  branch: string
  headSha: string
  base?: string
  baseSha?: string
  issue?: string
}>

/** Exercise the supported authored-root intake path used by tests whose real
 * subject is downstream candidate checking, reachability, or merge. */
async function submitCertifiedCarrier(
  app: CarrierSubmissionApp,
  repo: string,
  submission: CarrierSubmission,
): Promise<Change> {
  const base = submission.base ?? "main"
  await app.bays.submit({ ...submission, base, draft: true })
  const pr = Object.values(app.state().bays.prs).find(({ branch }) => branch === submission.branch)
  if (pr === undefined) throw new Error(`missing submitted carrier '${submission.branch}'`)
  const revision = currentChangeRev(pr)
  const baseSha = submission.baseSha ?? revision.baseSha ?? (await git(repo, ["merge-base", base, submission.headSha]))
  await using delegate = createProcess()
  const noHooks: Pick<Process, "run"> = {
    run(request) {
      const push = request.argv.indexOf("push")
      return push === -1
        ? delegate.run(request)
        : delegate.run({
            ...request,
            argv: [...request.argv.slice(0, push + 1), "--no-verify", ...request.argv.slice(push + 1)],
          })
    },
  }
  const remerge = await createGitChangeRemerger({ inject: { process: noHooks }, repo }).recut({
    id: pr.id,
    branch: submission.branch,
    base,
    revision: revision.n,
    headSha: submission.headSha,
    baseSha,
  })
  await app.bays.recut({
    pr: pr.id,
    fromRevision: revision.n,
    headSha: remerge.headSha,
    baseSha: remerge.baseSha,
    treeSha: remerge.treeSha,
    patchId: remerge.patchId,
    reviewCarried: false,
  })
  await app.bays.ready({ pr: pr.id })
  const certified = app.state().bays.prs[pr.id]
  if (certified === undefined) throw new Error(`missing certified carrier '${pr.id}'`)
  return certified
}

async function expectMerged(repo: string, evidence: GitCheckEvidence): Promise<void> {
  expect(await git(repo, ["rev-parse", "main"])).toBe(evidence.candidateSha)
  expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
}

function expectedCandidateRef(run: string, step: string, job: string, attempt: number, sha: string): string {
  const identity = createHash("sha256")
    .update(job)
    .update("\0")
    .update(String(attempt))
    .update("\0")
    .update(sha)
    .digest("hex")
  return `refs/yrd/candidates/${run}/${step}/attempt-${attempt}-${identity}`
}

describe("Queue command adapters", () => {
  it("classifies the actual Git subcommand when proving certification is mutation-free", () => {
    const mutating = [
      ["git", "-C", "/repo", "fetch", "origin"],
      ["git", "-C", "/repo", "-c", "user.name=Queue", "commit", "-m", "candidate"],
      ["git", "-C", "/repo", "add", "."],
      ["git", "-C", "/repo", "rm", "payload"],
      ["git", "-C", "/repo", "mv", "before", "after"],
      ["git", "-C", "/repo", "update-index", "--cacheinfo", "100644,abc,payload"],
      ["git", "-C", "/repo", "read-tree", "HEAD"],
      ["git", "-C", "/repo", "write-tree"],
      ["git", "-C", "/repo", "checkout-index", "-a"],
      ["git", "-C", "/repo", "hash-object", "-w", "payload"],
      ["git", "-C", "/repo", "mktree"],
      ["git", "-C", "/repo", "branch", "candidate"],
      ["git", "-C", "/repo", "tag", "candidate"],
      ["git", "-C", "/repo", "notes", "add", "-m", "proof"],
      ["git", "-C", "/repo", "replace", "old", "new"],
      ["git", "-C", "/repo", "worktree", "add", "/tmp/worktree", "HEAD"],
      ["git", "-C", "/repo", "update-ref", "refs/heads/main", "abc"],
      ["git", "-C", "/repo", "symbolic-ref", "HEAD", "refs/heads/main"],
      ["git", "-C", "/repo", "merge-tree", "--write-tree", "base", "head"],
    ] as const
    const readOnly = [
      ["git", "-C", "/repo/merge", "diff", "--", "merge"],
      ["git", "-C", "/repo", "-c", "alias.branch=log", "rev-parse", "branch"],
      ["git", "-C", "/repo", "worktree", "list", "--porcelain"],
      ["git", "-C", "/repo", "branch", "--show-current"],
      ["git", "-C", "/repo", "tag", "--list"],
      ["git", "-C", "/repo", "notes", "show", "HEAD"],
      ["git", "-C", "/repo", "replace", "--list"],
      ["git", "-C", "/repo", "hash-object", "payload"],
      ["git", "-C", "/repo", "apply", "--check", "payload.diff"],
      ["git", "-C", "/repo", "config", "--get", "remote.origin.url"],
    ] as const

    expect(mutating.map(gitInvocationMutates)).toEqual(mutating.map(() => true))
    expect(readOnly.map(gitInvocationMutates)).toEqual(readOnly.map(() => false))
  })

  it("does not classify failure outcomes by code prefix", async () => {
    const sourceRoot = new URL("../src/", import.meta.url)
    const matches: string[] = []
    for (const entry of await readdir(sourceRoot)) {
      if (!entry.endsWith(".ts")) continue
      const source = await readFile(new URL(entry, sourceRoot), "utf8")
      for (const match of source.matchAll(/\.code\.(?:startsWith|endsWith|includes|match|search)\s*\(/gu)) {
        matches.push(`${entry}:${match[0]}`)
      }
    }
    expect(matches).toEqual([])
  })

  it("reports an absent Candidate ref as a write refusal with Git evidence", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    // Matched by PREFIX: the ref is named after the composed SHA, which this
    // test cannot know before the preparer computes it.
    const refusingProcess: Pick<Process, "run"> = {
      async run(request) {
        const target = request.argv[5]
        if (
          request.argv[0] === "git" &&
          request.argv[3] === "update-ref" &&
          target?.startsWith(`${CANDIDATE_REF_NAMESPACE}/`) === true
        ) {
          return {
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: `fatal: cannot lock ref '${target}': transient lock failure`,
            durationMs: 1,
            timedOut: false,
            verdict: "EXITED",
          }
        }
        return process.run(request)
      },
    }
    const preparer = gitCandidatePreparer({ inject: { process: refusingProcess }, repo })
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })

    await expect(
      preparer({
        id: "C1",
        queueId: "main",
        baseSha,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "infrastructure",
        code: "candidate-ref-refused",
        message: expect.stringContaining("could not be created: fatal: cannot lock ref"),
      },
    })
    // The whole namespace, so a refused write cannot leave evidence behind under
    // some other name.
    expect(await git(repo, ["for-each-ref", "--format=%(refname)", CANDIDATE_REF_NAMESPACE])).toBe("")
  })

  it("keeps a genuinely occupied Candidate ref distinct from an absent write refusal", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    let raced = false
    let racedRef = ""
    // A content-addressed name states its own target, so this models CORRUPTION
    // rather than a peer run: something parked a different commit at a name that
    // says it holds the composed evidence.
    const racingProcess: Pick<Process, "run"> = {
      async run(request) {
        const target = request.argv[5]
        if (
          !raced &&
          request.argv[0] === "git" &&
          request.argv[3] === "update-ref" &&
          target?.startsWith(`${CANDIDATE_REF_NAMESPACE}/`) === true
        ) {
          raced = true
          racedRef = target
          await git(repo, ["update-ref", target, baseSha])
        }
        return process.run(request)
      },
    }
    const preparer = gitCandidatePreparer({ inject: { process: racingProcess }, repo })
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })

    await expect(
      preparer({
        id: "C1",
        queueId: "main",
        baseSha,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "infrastructure",
        code: "candidate-ref-refused",
        // Distinct from the "could not be created" sentence above: this one names
        // the disagreement between the ref's name and what it resolves to.
        message: expect.stringContaining("which is not the evidence its content-addressed name states"),
      },
    })
    expect(raced).toBe(true)
    expect(await git(repo, ["rev-parse", racedRef])).toBe(baseSha)
  })

  // 22332, against a real repository: the acceptance shape. Two composes of the
  // SAME Candidate id that produce different trees both publish, because the ref
  // is derived from the evidence. Under the id-named scheme the second refused
  // itself with "compose self-retry must allocate a fresh id".
  it("publishes two different composes of one Candidate id without a self-collision (22332)", async () => {
    const { repo, alpha, beta } = await repository("alpha", "beta")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const preparer = gitCandidatePreparer({ inject: { process }, repo })
    const snapshot = (branch: string, headSha: string) =>
      ChangeSnapshotSchema.parse({ id: "PR1", branch, base: "main", revision: 1, headSha, baseSha })

    // Both prepares are handed the SAME id — this is precisely the case the old
    // scheme could not survive.
    const compose = async (branch: string, headSha: string) => {
      const pr = snapshot(branch, headSha)
      return preparer({
        id: "C1",
        queueId: "main",
        baseSha,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      })
    }

    const first = await compose("issue/alpha", alpha)
    const second = await compose("issue/beta", beta)

    // Different trees, so different evidence, so different refs — no refusal.
    expect(first.mergeability).toBe("mergeable")
    expect(second.mergeability).toBe("mergeable")
    expect(first.sha).not.toBe(second.sha)
    expect(first.ref).toBe(candidateRefFor(first.sha ?? ""))
    expect(second.ref).toBe(candidateRefFor(second.sha ?? ""))
    expect(first.ref).not.toBe(second.ref)

    // Both are really on disk, and each resolves to the evidence its name states.
    expect(await git(repo, ["rev-parse", first.ref ?? ""])).toBe(first.sha)
    expect(await git(repo, ["rev-parse", second.ref ?? ""])).toBe(second.sha)
    const published = (await git(repo, ["for-each-ref", "--format=%(refname)", CANDIDATE_REF_NAMESPACE]))
      .split("\n")
      .filter((line) => line !== "")
    expect(published.toSorted()).toEqual([first.ref, second.ref].toSorted())
  })

  // The other half of "by construction": identical evidence is idempotent rather
  // than a collision, so a retry that recomposes the SAME tree is a no-op.
  it("republishes an identical compose onto the same ref without refusing (22332)", async () => {
    const { repo, alpha } = await repository("alpha")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const preparer = gitCandidatePreparer({ inject: { process }, repo })
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/alpha",
      base: "main",
      revision: 1,
      headSha: alpha,
      baseSha,
    })
    const input = {
      id: "C1",
      queueId: "main",
      baseSha,
      revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
      prs: [pr],
    }

    const first = await preparer(input)
    const second = await preparer(input)

    expect(second.ref).toBe(first.ref)
    expect(second.sha).toBe(first.sha)
    const published = (await git(repo, ["for-each-ref", "--format=%(refname)", CANDIDATE_REF_NAMESPACE]))
      .split("\n")
      .filter((line) => line !== "")
    expect(published).toEqual([first.ref])
  })

  it("recuts one direct payload as an exact direct child and refuses overlapping authority", async () => {
    const { repo, candidate } = await repository("candidate")
    const oldBaseSha = await git(repo, ["rev-parse", "main"])
    await writeFile(join(repo, "upstream.txt"), "upstream\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])
    const currentBaseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const remerger = createGitChangeRemerger({ inject: { process }, repo })

    const result = await remerger.recut({
      id: "PR1",
      branch: "issue/candidate",
      base: "main",
      revision: 1,
      headSha: candidate,
      baseSha: oldBaseSha,
    })

    expect(result).toMatchObject({
      baseSha: currentBaseSha,
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      treeSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
    })
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(currentBaseSha)
    expect(await git(repo, ["diff", "--name-only", currentBaseSha, result.headSha])).toBe("candidate.txt")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")

    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "candidate.txt"), "authority overlap\n")
    await git(repo, ["add", "candidate.txt"])
    await git(repo, ["commit", "-qm", "overlap candidate"])
    await expect(
      remerger.recut({
        id: "PR2",
        branch: "issue/candidate",
        base: "main",
        revision: 1,
        headSha: candidate,
        baseSha: oldBaseSha,
      }),
    ).rejects.toMatchObject({
      // Re-merge Phase 1 (22925 family): the direct path refuses a genuine
      // content conflict as `merge-conflict` now (CONFLICT_CODES_TO_RENAME in
      // command.ts), not the rebase-path's `recut-conflict` - the property
      // (a real conflict is refused, naming the conflicted file) survives
      // unchanged; only the retired code name needed updating.
      failure: { kind: "refusal", code: "merge-conflict", message: expect.stringContaining("candidate.txt") },
    })
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("certifies an independently authored code proposal as its exact SHA without replay or publication", async () => {
    const fixture = await codeCarrierProposalRepository()
    expect(await git(fixture.repo, ["rev-list", "--count", `${fixture.approvedBaseSha}..${fixture.approvedSha}`])).toBe(
      "2",
    )
    expect(await git(fixture.repo, ["rev-list", "--count", `${fixture.currentBaseSha}..${fixture.exact.sha}`])).toBe(
      "1",
    )
    await using process = createProcess()
    const observed = observeGitMutations(process)

    const result = await remergeProposedCodeCarrier(
      createGitChangeRemerger({ inject: { process: observed.process }, repo: fixture.repo }),
      {
        id: "PR1",
        branch: "issue/approved",
        base: "main",
        revision: 1,
        headSha: fixture.approvedSha,
        baseSha: fixture.approvedBaseSha,
      },
      fixture.exact.sha,
    )

    expect({ headSha: result.headSha, mutations: observed.mutations }).toEqual({
      headSha: fixture.exact.sha,
      mutations: [],
    })
    expect(await git(fixture.repo, ["rev-parse", fixture.exact.ref])).toBe(fixture.exact.sha)
  })

  it("scopes lazy-fetch refusal to immutable certification instead of ordinary Queue Git", async () => {
    const fixture = await codeCarrierProposalRepository()
    await using process = createProcess()
    const noLazyFetch: Array<string | undefined> = []
    const recordingProcess: Pick<Process, "run"> = {
      run(request) {
        noLazyFetch.push(request.env?.GIT_NO_LAZY_FETCH)
        return process.run(request)
      },
    }

    await inspectGitQueueTarget({ inject: { process: recordingProcess }, repo: fixture.repo, branch: "main" })
    expect(noLazyFetch).not.toContain("1")
    noLazyFetch.length = 0

    await remergeProposedCodeCarrier(
      createGitChangeRemerger({ inject: { process: recordingProcess }, repo: fixture.repo }),
      {
        id: "PR1",
        branch: "issue/approved",
        base: "main",
        revision: 1,
        headSha: fixture.approvedSha,
        baseSha: fixture.approvedBaseSha,
      },
      fixture.exact.sha,
    )
    expect(noLazyFetch.length).toBeGreaterThan(0)
    expect(new Set(noLazyFetch)).toEqual(new Set(["1"]))
  })

  it("refuses a locally divergent target without fetching or certifying an arbitrary side", async () => {
    const fixture = await codeCarrierProposalRepository()
    const remote = join(fixture.repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(fixture.repo, ["remote", "add", "origin", remote])
    await git(fixture.repo, ["push", "-q", "origin", "main"])
    await writeFile(join(fixture.repo, "local-only.txt"), "local divergence\n")
    await git(fixture.repo, ["add", "local-only.txt"])
    await git(fixture.repo, ["commit", "-qm", "local divergence"])
    await using process = createProcess()
    const observed = observeGitMutations(process)

    await expect(
      remergeProposedCodeCarrier(
        createGitChangeRemerger({ inject: { process: observed.process }, repo: fixture.repo }),
        {
          id: "PR1",
          branch: "issue/approved",
          base: "main",
          revision: 1,
          headSha: fixture.approvedSha,
          baseSha: fixture.approvedBaseSha,
        },
        fixture.exact.sha,
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "queue-environment-refused",
        message: expect.stringContaining("local/cached target refs"),
      },
    })
    expect(observed.mutations).toEqual([])
  })

  it("refuses a stale cached target after proving live origin authority without mutating Git", async () => {
    const fixture = await codeCarrierProposalRepository()
    const remote = join(fixture.repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(fixture.repo, ["remote", "add", "origin", remote])
    await git(fixture.repo, ["push", "-q", "origin", "main"])
    await git(fixture.repo, ["switch", "-qc", "remote-advance", fixture.currentBaseSha])
    await writeFile(join(fixture.repo, "remote-only.txt"), "live authority advanced\n")
    await git(fixture.repo, ["add", "remote-only.txt"])
    await git(fixture.repo, ["commit", "-qm", "advance live authority"])
    await git(fixture.repo, ["push", "-q", "origin", "HEAD:main"])
    await git(fixture.repo, ["switch", "-q", "main"])
    await git(fixture.repo, ["update-ref", "refs/remotes/origin/main", fixture.currentBaseSha])
    expect(await git(fixture.repo, ["rev-parse", "main"])).toBe(fixture.currentBaseSha)
    expect(await git(fixture.repo, ["rev-parse", "origin/main"])).toBe(fixture.currentBaseSha)
    await using process = createProcess()
    const observed = observeGitMutations(process)

    await expect(
      remergeProposedCodeCarrier(
        createGitChangeRemerger({ inject: { process: observed.process }, repo: fixture.repo }),
        {
          id: "PR1",
          branch: "issue/approved",
          base: "main",
          revision: 1,
          headSha: fixture.approvedSha,
          baseSha: fixture.approvedBaseSha,
        },
        fixture.exact.sha,
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "queue-environment-refused",
        message: expect.stringContaining("live 'origin/main'"),
      },
    })
    expect(observed.mutations).toEqual([])
  })


  /**
   * A repository with gitlink "dep" pinned to `initialSha` on `main`, plus
   * three throwaway commit shas usable as gitlink VALUES. deriveFrozenCodeCarrier
   * proves gitlink values agree, never that they resolve as real submodule
   * objects — on-main-ness (ancestry against a real submodule checkout) is
   * recut-gitlink-ff.test.ts's concern, not this certificate's — so ordinary
   * throwaway commits from this same repo work fine as pins.
   */
  async function gitlinkCertificateRepository(): Promise<{
    repo: string
    initialSha: string
    sourceBaseSha: string
    minCommitPin: string
    advancedPin: string
    unrelatedPin: string
  }> {
    const { repo } = await repository()
    const initialSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${initialSha},dep`])
    await git(repo, ["commit", "-qm", "baseline: add dep gitlink"])
    const sourceBaseSha = await git(repo, ["rev-parse", "main"])
    const pin = async (label: string): Promise<string> => {
      await git(repo, ["switch", "-qc", `pin/${label}`, "main"])
      await writeFile(join(repo, `${label}.marker`), `${label}\n`)
      await git(repo, ["add", `${label}.marker`])
      await git(repo, ["commit", "-qm", `pin ${label}`])
      const sha = await git(repo, ["rev-parse", "HEAD"])
      await git(repo, ["switch", "-q", "main"])
      return sha
    }
    return {
      repo,
      initialSha,
      sourceBaseSha,
      minCommitPin: await pin("min-commit"),
      advancedPin: await pin("advanced"),
      unrelatedPin: await pin("unrelated"),
    }
  }

  it("certifies a recut that preserves an authored gitlink floor verbatim", async () => {
    const fixture = await gitlinkCertificateRepository()
    await git(fixture.repo, ["switch", "-qc", "issue/source", fixture.sourceBaseSha])
    await git(fixture.repo, ["update-index", "--cacheinfo", `160000,${fixture.minCommitPin},dep`])
    await writeFile(join(fixture.repo, "code.txt"), "code a\n")
    await git(fixture.repo, ["add", "code.txt"])
    await git(fixture.repo, ["commit", "-qm", "bump dep to floor + code"])
    const sourceHeadSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    // An independently-produced recut with the identical tree: a real rebase
    // always mints a new commit sha even when nothing about the content moved.
    await git(fixture.repo, ["switch", "-qc", "issue/candidate", fixture.sourceBaseSha])
    await git(fixture.repo, ["update-index", "--cacheinfo", `160000,${fixture.minCommitPin},dep`])
    await writeFile(join(fixture.repo, "code.txt"), "code a\n")
    await git(fixture.repo, ["add", "code.txt"])
    await git(fixture.repo, ["commit", "-qm", "recut: bump dep to floor + code"])
    const candidateSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])
    expect(candidateSha).not.toBe(sourceHeadSha)

    await using process = createProcess()
    const result = await remergeProposedCodeCarrier(
      createGitChangeRemerger({ inject: { process }, repo: fixture.repo }),
      {
        id: "PR1",
        branch: "issue/source",
        base: "main",
        revision: 1,
        headSha: sourceHeadSha,
        baseSha: fixture.sourceBaseSha,
      },
      candidateSha,
    )
    expect(result.headSha).toBe(candidateSha)
    expect(result.baseSha).toBe(fixture.sourceBaseSha)
  })

  it("certifies a recut that adopts the target's advanced value at the candidate base", async () => {
    const fixture = await gitlinkCertificateRepository()
    await git(fixture.repo, ["switch", "-qc", "issue/source", fixture.sourceBaseSha])
    await git(fixture.repo, ["update-index", "--cacheinfo", `160000,${fixture.minCommitPin},dep`])
    await writeFile(join(fixture.repo, "code.txt"), "code a\n")
    await git(fixture.repo, ["add", "code.txt"])
    await git(fixture.repo, ["commit", "-qm", "bump dep to floor + code"])
    const sourceHeadSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    // main independently advances dep past the floor before the recut merges.
    await writeFile(join(fixture.repo, "upstream.txt"), "upstream\n")
    await git(fixture.repo, ["add", "upstream.txt"])
    await git(fixture.repo, ["update-index", "--cacheinfo", `160000,${fixture.advancedPin},dep`])
    await git(fixture.repo, ["commit", "-qm", "main: advance dep past the floor"])
    const advancedBaseSha = await git(fixture.repo, ["rev-parse", "main"])

    // The recut's own diff carries only the code change: git's fast-forward
    // conflict resolution kept the target's newer dep value, so dep never
    // shows up as a "changed" path between advancedBaseSha and candidateSha.
    await git(fixture.repo, ["switch", "-qc", "issue/candidate", advancedBaseSha])
    await writeFile(join(fixture.repo, "code.txt"), "code a\n")
    await git(fixture.repo, ["add", "code.txt"])
    await git(fixture.repo, ["commit", "-qm", "recut: code only, dep ff-resolved"])
    const candidateSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    await using process = createProcess()
    const result = await remergeProposedCodeCarrier(
      createGitChangeRemerger({ inject: { process }, repo: fixture.repo }),
      {
        id: "PR1",
        branch: "issue/source",
        base: "main",
        revision: 1,
        headSha: sourceHeadSha,
        baseSha: fixture.sourceBaseSha,
      },
      candidateSha,
    )
    expect(result.headSha).toBe(candidateSha)
    expect(result.baseSha).toBe(advancedBaseSha)
    expect(await git(fixture.repo, ["ls-tree", "--format=%(objectname)", candidateSha, "--", "dep"])).toBe(
      fixture.advancedPin,
    )
  })


  it("certifies a no-gitlink recut exactly as before (gitlink obligations never engage)", async () => {
    const fixture = await gitlinkCertificateRepository()
    await git(fixture.repo, ["switch", "-qc", "issue/source", fixture.sourceBaseSha])
    await writeFile(join(fixture.repo, "code.txt"), "code a\n")
    await git(fixture.repo, ["add", "code.txt"])
    await git(fixture.repo, ["commit", "-qm", "code only"])
    const sourceHeadSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    await git(fixture.repo, ["switch", "-qc", "issue/candidate", fixture.sourceBaseSha])
    await writeFile(join(fixture.repo, "code.txt"), "code a\n")
    await git(fixture.repo, ["add", "code.txt"])
    await git(fixture.repo, ["commit", "-qm", "recut: code only, independently authored"])
    const candidateSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])
    expect(candidateSha).not.toBe(sourceHeadSha)

    await using process = createProcess()
    const result = await remergeProposedCodeCarrier(
      createGitChangeRemerger({ inject: { process }, repo: fixture.repo }),
      {
        id: "PR1",
        branch: "issue/source",
        base: "main",
        revision: 1,
        headSha: sourceHeadSha,
        baseSha: fixture.sourceBaseSha,
      },
      candidateSha,
    )
    expect(result.headSha).toBe(candidateSha)
    // No gitlink pathspec exclusion applies: the certified patch id is
    // exactly the plain, unfiltered patch id — unchanged from before this
    // gitlink work existed.
    const directPatchId = await stablePatchId(fixture.repo, fixture.sourceBaseSha, sourceHeadSha)
    expect(result.patchId).toBe(directPatchId)
  })


  // A0 correction (2026-08-23): the prior commit on this branch (971b5a04)
  // deleted this test and the oversized-payload test below, citing a
  // "team-lead ruling" that does not match the ruling actually given.
  // Restored per direct instruction: this test's body no longer exercises
  // certification (it recuts a ten-commit branch over an advanced base and
  // asserts patchId format + unchanged:false, nothing range-diff-shaped), so
  // it is renamed rather than deleted. No duplicate multi-commit-breadth
  // coverage exists elsewhere in this package (searched: no other test title
  // matches multi-commit/ten-commit/range-diff).
  it("recuts a ten-commit branch over an advanced base", async () => {
    const { repo } = await repository()
    const oldBaseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["switch", "-qc", "issue/multi"])
    for (const name of Array.from({ length: 10 }, (_, index) => `change-${String(index + 1).padStart(2, "0")}`)) {
      await writeFile(join(repo, `${name}.txt`), `${name}\n`)
      await git(repo, ["add", `${name}.txt`])
      await git(repo, ["commit", "-qm", `add ${name}`])
    }
    const featureSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "upstream.txt"), "advance authority\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])

    await using process = createProcess()
    await expect(
      createGitChangeRemerger({ inject: { process }, repo }).recut({
        id: "PR99",
        branch: "issue/multi",
        base: "main",
        revision: 1,
        headSha: featureSha,
        baseSha: oldBaseSha,
      }),
    ).resolves.toMatchObject({
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
    })
  })

  // Task C, "wiring-level interim test through the seam": the DI seam
  // (`createGitChangeRemerger().recut`, `remergeChange`'s dispatcher) adapts
  // `rebuildCandidateByMerge`'s pure-git result to `ChangeRemergeResult`
  // (command.ts, `remergeDirectChangeByMerge`'s own return statement) with
  // exactly five fields — headSha, baseSha, treeSha, patchId, unchanged — and
  // no `composition` or `sourceRewrites` key at all for the direct case,
  // unlike the composed path's return a few lines above it in the same
  // dispatcher. That is the "plain identity, not a certificate" property Q3
  // describes at the type level: nothing here is proving equivalence to a
  // rewrite, so there is nothing to carry a composition/rewrite record for.
  // No existing test asserts the field set directly; every other recut()
  // caller uses `toMatchObject`, which only checks the fields it names and
  // says nothing about a field's ABSENCE.
  it("direct recut result carries only the five plain-identity fields, no composition or sourceRewrites", async () => {
    const { repo } = await repository()
    const oldBaseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["switch", "-qc", "issue/plain-identity"])
    await writeFile(join(repo, "feature.txt"), "feature\n")
    await git(repo, ["add", "feature.txt"])
    await git(repo, ["commit", "-qm", "feature"])
    const featureSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "upstream.txt"), "advance authority\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])

    await using process = createProcess()
    const result = await createGitChangeRemerger({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/plain-identity",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha: oldBaseSha,
    })

    expect(Object.keys(result).toSorted()).toEqual(["baseSha", "headSha", "patchId", "treeSha", "unchanged"])
    expect(result).toMatchObject({
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      treeSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
    })
    // A genuine merge candidate, not the author's tip passed through: never
    // rewritten (Q1) — it survives as the merge commit's own second parent.
    expect(result.headSha).not.toBe(featureSha)
    expect(await git(repo, ["rev-parse", `${result.headSha}^2`])).toBe(featureSha)
  })

  // A0 correction (2026-08-23): restored per direct instruction — this test
  // was RED and UNEXAMINED at the time 971b5a04 deleted it, which classified
  // it as "dies with the mechanism" with no root cause, forbidden per
  // instruction. Root cause, found by running it in isolation: a ZodError on
  // the fixture's own `id: "PR-OVERSIZED"`, which fails the `id` schema's
  // `/^PR\d+$/u` pattern (letters/hyphen not allowed) — nothing to do with
  // certification or a process-output ceiling at all. Fixed to `"PR9999"`;
  // the test then passes cleanly, proving the plain-identity patchId pipe
  // handles a 17MB payload fine — no live bug in the new code. Kept and
  // renamed to drop stale "certificate" language (patchId is plain identity
  // now, Q3).
  it("recuts a direct payload that exceeds the process output ceiling", async () => {
    const { repo } = await repository()
    const oldBaseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["switch", "-qc", "issue/oversized"])
    await writeFile(join(repo, "oversized.txt"), `${"x".repeat(17 * 1024 * 1024)}\n`)
    await git(repo, ["add", "oversized.txt"])
    await git(repo, ["commit", "-qm", "oversized payload"])
    const featureSha = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "upstream.txt"), "advance authority\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])
    const currentBaseSha = await git(repo, ["rev-parse", "main"])

    await using process = createProcess()
    const result = await createGitChangeRemerger({ inject: { process }, repo }).recut({
      id: "PR9999",
      branch: "issue/oversized",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha: oldBaseSha,
    })

    expect(result).toMatchObject({
      baseSha: currentBaseSha,
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
    })
  })


  // A0 correction (2026-08-23): 971b5a04 deleted this test outright, citing
  // an unverified redundancy claim ("ordinary recut-correctness coverage
  // elsewhere already exercises it") with no rg evidence — a bare deletion
  // claim is not evidence-gated per Q4. This test was NOT in scope of the
  // direct A0 instruction (which named only the two tests restored above),
  // meaning the prior adaptation below — already stripped of its retired
  // rebase-hygiene check, keeping only the two properties that survive the
  // merge model (patchId is textconv-independent; final content is right)
  // — was implicitly the correct state. Restored to that adapted form.
  it("recut result is textconv-independent for patchId and final content", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, ".gitattributes"), "payload.dat diff=canonical\n")
    await writeFile(join(repo, "payload.dat"), "alpha\n")
    await git(repo, ["add", ".gitattributes", "payload.dat"])
    await git(repo, ["commit", "-qm", "add attributed payload"])
    const baseSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["config", "diff.canonical.textconv", "sed 's/.*/CANON/'"])
    await git(repo, ["switch", "-qc", "issue/payload"])
    await writeFile(join(repo, "payload.dat"), "beta\n")
    await git(repo, ["commit", "-qam", "change payload"])
    const headSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "upstream.txt"), "upstream\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])
    expect(await git(repo, ["diff", baseSha, headSha, "--", "payload.dat"])).toBe("")
    const rawDiff = await git(repo, ["diff", "--no-textconv", baseSha, headSha, "--", "payload.dat"])
    expect(rawDiff).toContain("-alpha")
    expect(rawDiff).toContain("+beta")

    await using process = createProcess()
    // Re-merge Phase 1 (22925 family): the direct path is rebuilt by MERGE,
    // never rebase, so `expectNonInteractiveRebases` (a hygiene check on the
    // OLD rebase invocation's `-c core.editor=true` flag) tests a mechanism
    // this path no longer has — no rebase command is ever run, so the
    // property it proved cannot apply. The property that DOES survive —
    // certificate correctness is textconv-independent, and the final content
    // is right — is the two assertions kept below.
    const result = await createGitChangeRemerger({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/payload",
      base: "main",
      revision: 1,
      headSha,
      baseSha,
    })

    expect(result.patchId).toMatch(/^[0-9a-f]{40}$/u)
    expect(await git(repo, ["show", `${result.headSha}:payload.dat`])).toBe("beta")
  })

  it("certifies the raw carrier object when a local replacement ref is present", async () => {
    const { repo } = await repository()
    const baseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["switch", "-qc", "issue/raw"])
    await writeFile(join(repo, "payload.txt"), "raw carrier\n")
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", "raw carrier"])
    const rawSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-qc", "issue/replacement", baseSha])
    await writeFile(join(repo, "payload.txt"), "replacement view\n")
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", "replacement view"])
    const replacementSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["replace", rawSha, replacementSha])
    const rawTree = await git(repo, ["--no-replace-objects", "rev-parse", `${rawSha}^{tree}`])
    expect(await git(repo, ["rev-parse", `${rawSha}^{tree}`])).not.toBe(rawTree)

    await using process = createProcess()
    const result = await createGitChangeRemerger({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/raw",
      base: "main",
      revision: 1,
      headSha: rawSha,
      baseSha,
    })

    expect(result).toMatchObject({ headSha: rawSha, treeSha: rawTree, unchanged: true })
  })

  it("recuts from the source merge base when submission recorded authoritative current base", async () => {
    const { repo } = await repository()
    const baseLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    await writeFile(join(repo, "README.md"), `${baseLines.join("\n")}\n`)
    await git(repo, ["commit", "-qam", "expand fixture"])
    await git(repo, ["switch", "-qc", "issue/candidate"])
    const sourceLines = [...baseLines]
    sourceLines[17] = "source change"
    await writeFile(join(repo, "README.md"), `${sourceLines.join("\n")}\n`)
    await git(repo, ["commit", "-qam", "candidate"])
    const candidate = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    const authorityLines = [...baseLines]
    authorityLines[1] = "authority change"
    await writeFile(join(repo, "README.md"), `${authorityLines.join("\n")}\n`)
    await git(repo, ["commit", "-qam", "advance authority"])
    const currentBaseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()

    const result = await createGitChangeRemerger({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/candidate",
      base: "main",
      revision: 1,
      headSha: candidate,
      baseSha: currentBaseSha,
    })

    expect(result).toMatchObject({
      baseSha: currentBaseSha,
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      treeSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
    })
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(currentBaseSha)
    expect(await git(repo, ["diff", "--name-only", currentBaseSha, result.headSha])).toBe("README.md")
    expect(await git(repo, ["show", `${result.headSha}:README.md`])).toContain("authority change\n")
    expect(await git(repo, ["show", `${result.headSha}:README.md`])).toContain("source change\n")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("refuses to recut an authored root whose gitlink pin is unpublished on the submodule's main", async () => {
    const { repo } = await repository()
    const doctrineText = (lines: readonly string[]) => `${lines.join("\n")}\n`
    const module = join(repo, "..", "module")
    await Bun.$`git init -q -b main ${module}`
    await git(module, ["config", "user.name", "Yrd Test"])
    await git(module, ["config", "user.email", "yrd@example.invalid"])
    await writeFile(join(module, "README.md"), "base\n")
    await git(module, ["add", "README.md"])
    await git(module, ["commit", "-qm", "base"])
    const oldPin = await git(module, ["rev-parse", "HEAD"])

    await git(repo, ["config", "protocol.file.allow", "always"])
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
    await writeFile(join(repo, ".gitattributes"), "doctrine.md merge=union\n")
    await writeFile(
      join(repo, "doctrine.md"),
      doctrineText(["Validate admitted work.", "Result marker: �(", "Keep it flowing."]),
    )
    await git(repo, ["add", ".gitattributes", "doctrine.md"])
    await git(repo, ["commit", "-qam", "add dependency"])
    const sourceBase = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["branch", "issue/root", sourceBase])

    await git(module, ["switch", "-qc", "issue/source"])
    await writeFile(join(module, "source-a.ts"), "export const source = 'authored context'\n")
    await git(module, ["add", "source-a.ts"])
    await git(module, ["commit", "-qm", "source a"])
    await writeFile(join(module, "source-a.ts"), "export const source = 'settled'\n")
    await writeFile(join(module, "source-b.ts"), "export const b = true\n")
    await git(module, ["add", "source-a.ts", "source-b.ts"])
    await git(module, ["commit", "-qm", "source b"])
    const sourceTip = await git(module, ["rev-parse", "HEAD"])

    await git(module, ["switch", "-q", "main"])
    await writeFile(join(module, "upstream.ts"), "export const upstream = true\n")
    await writeFile(join(module, "source-a.ts"), "export const source = 'current context'\n")
    await git(module, ["add", "upstream.ts", "source-a.ts"])
    await git(module, ["commit", "-qm", "current source base"])
    const composedBase = await git(module, ["rev-parse", "HEAD"])
    await writeFile(join(module, "source-a.ts"), "export const source = 'settled'\n")
    await writeFile(join(module, "source-b.ts"), "export const b = true\n")
    await git(module, ["add", "source-a.ts", "source-b.ts"])
    await git(module, ["commit", "-qm", "compose current source"])
    const composedTip = await git(module, ["rev-parse", "HEAD"])
    await writeFile(join(module, "repair.ts"), "export const repair = true\n")
    await git(module, ["add", "repair.ts"])
    await git(module, ["commit", "-qm", "repair source tooling"])
    const currentPin = await git(module, ["rev-parse", "HEAD"])
    expect(currentPin).not.toBe(sourceTip)
    expect(await git(module, ["cherry", currentPin, sourceTip, oldPin])).toMatch(/^\+ [0-9a-f]{40}/u)

    await git(join(repo, "dep"), ["fetch", "-q", "origin"])
    await git(join(repo, "dep"), ["checkout", "-q", currentPin])
    await writeFile(
      join(repo, "doctrine.md"),
      doctrineText([
        "Validate admitted work.",
        "Execute the generated `current_command` verbatim.",
        "Result marker: �(",
        "Keep it flowing.",
      ]),
    )
    await git(repo, ["add", "dep"])
    await git(repo, ["add", "doctrine.md"])
    await git(repo, ["commit", "-qm", "advance authoritative dependency"])
    const currentBase = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-q", "issue/root"])
    await git(join(repo, "dep"), ["checkout", "-q", sourceTip])
    await writeFile(
      join(repo, "doctrine.md"),
      doctrineText([
        "Validate admitted work.",
        "Execute the generated `current_command` verbatim.",
        "For authored roots, draft then recut the same PR.",
        "Result marker: �(",
        "Keep it flowing.",
      ]),
    )
    await git(repo, ["add", "dep", "doctrine.md"])
    await git(repo, ["commit", "-qm", "authored root"])
    const authoredHead = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["submodule", "update", "--init", "--recursive"])
    await using process = createProcess()
    const remerger = createGitChangeRemerger({ inject: { process }, repo })
    const input = {
      id: "PR1",
      branch: "issue/root",
      base: "main",
      revision: 1,
      headSha: authoredHead,
      baseSha: currentBase,
    }
    // A1 (2026-08-23): the fixture's authored gitlink pin (sourceTip) lives
    // only on the module's unpublished `issue/source` branch, never merged
    // to the module's own main (currentPin descends from oldPin via a
    // different, convergent-content path — see the `git cherry` assertion
    // above). Under the old certification model this was an ancestry-walk
    // failure between two divergent submodule tips; under the merge model,
    // Phase 1's gitlink fill-in requires the authored min commit to be
    // published on the submodule's main before it can be used at all, so
    // this now refuses with `min-commit-unpublished` instead — verified
    // against the fixture, not guessed: this is the correct, by-design
    // refusal for an unpublished submodule pin (plan §3 test 5's shape).
    //
    // The rest of this fixture (composedBase/composedTip/currentPin/
    // sourceBase, all built for a SECOND, composed-path call using
    // `currentCompositions`) moved to the next test, below — see its header
    // comment for why that half needed splitting out and is currently
    // skipped, discovered while verifying this fix (A1).
    await expect(remerger.recut(input)).rejects.toThrow(
      /change 'PR1' cannot fill the shaset: 'dep' authored min commit '[0-9a-f]{40}' is not on submodule main '[0-9a-f]{40}'; the author's gitlink is a min commit, never a value — push it to the submodule's own main first, then resubmit/u,
    )
  })


  it("recuts a two-commit authored branch that preserves an authored root gitlink", async () => {
    const { repo, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "base",
      splitCarrier: true,
    })
    await writeFile(join(repo, "upstream.txt"), "upstream\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])
    await git(repo, ["push", "-q", "origin", "main"])
    await writeFile(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n")
    await using process = createProcess()
    const remerge = await createGitChangeRemerger({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })
    // A2 (2026-08-23): the fixture's authored branch still carries exactly
    // two commits ("feature dependency", "feature" — the title's "two-commit"
    // describes THIS, unchanged). What changed is what `baseSha..headSha`
    // counts: the old rebase-based path REPLAYED those two commits linearly
    // on the new base, so the range was exactly those two commits. The merge
    // model instead produces ONE merge commit (`yrd: merge PR1 revision 1`,
    // first parent = baseSha directly, second parent = the ORIGINAL authored
    // tip, byte-for-byte, per Q1's "authored tip is never rewritten") on top
    // of the base — and a merge commit's second-parent history becomes newly
    // reachable in `base..head` for the first time (a rebase's linear replay
    // never had a second parent to make that history reachable this way).
    // Confirmed directly, not assumed (temporary instrumentation, removed):
    // `headSha~1` (first-parent) === baseSha exactly; `headSha^2` (second
    // parent) === the original, unrewritten "feature" commit sha; the
    // all-paths reversed subject list is exactly the 2 authored commits (in
    // their original order) followed by the merge commit. Total: 2 authored
    // + 1 merge = 3, not a bug — the natural, expected shape of a
    // non-conflicting single-sided gitlink advance built by merge instead of
    // rebase (this fixture's `requiredVersion: "base"` means main's own `dep`
    // pin never moved, so no gitlink pre-branch/shaset fill-in is needed
    // either — the merge is clean, nothing else added to the count).
    expect(await git(repo, ["rev-list", "--count", `${remerge.baseSha}..${remerge.headSha}`])).toBe("3")
    expect(await git(repo, ["rev-parse", `${remerge.headSha}~1`])).toBe(remerge.baseSha)
    expect(await git(repo, ["rev-parse", `${remerge.headSha}^2`])).toBe(featureSha)
    expect(
      (await git(repo, ["log", "--reverse", "--format=%s", `${remerge.baseSha}..${remerge.headSha}`])).split("\n"),
    ).toEqual(["feature dependency", "feature", "yrd: merge PR1 revision 1"])
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main", baseSha, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: remerge.headSha,
      baseSha: remerge.baseSha,
      treeSha: remerge.treeSha,
      patchId: remerge.patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    await git(repo, ["fetch", "-q", "origin", "main"])
    expect(await git(repo, ["ls-tree", "FETCH_HEAD", "dep"])).toBe(await git(repo, ["ls-tree", remerge.headSha, "dep"]))
  })

  // @i/10-merge-queue/coupled-pin-and-code box 4: "a regression proves the unit
  // merges green WHERE EITHER HALF ALONE IS RED."
  //
  // The coupled merge test directly above gates its run with ["true"] — a
  // check that cannot fail — and then asserts only `ls-tree dep`. So it proves
  // the gitlink survived a gate incapable of judging it, and says nothing about
  // the root half at all. Merge green is not the claim the bead makes;
  // merge green under a gate that COULD have failed is.
  //
  // These three share one coupling-sensitive gate that reads the submodule's
  // content AND a root file. The green below is only worth anything because the
  // two reds use the same gate: together they show the gate can tell the halves
  // apart, which is what "gated as a unit" means.
  const couplingSensitiveGate = shellCommand(
    "git -c protocol.file.allow=always submodule update --init --recursive && " +
      'test "$(cat dep/version.txt)" = candidate && ' +
      "test -f feature.txt",
  )

  it("merges a coupled gitlink and root change as one unit under a gate that reads both halves", async () => {
    const { repo, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, couplingSensitiveGate)
    const pr = await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha, baseSha })

    const run = (await app.queue.run({ prs: [pr.id] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    await git(repo, ["fetch", "-q", "origin", "main"])
    // BOTH halves on main, not just the gitlink. The older test asserts only the
    // first of these, so a merge that silently dropped the root file would pass
    // it — the exact silent split box 5 forbids.
    expect(await git(repo, ["ls-tree", "FETCH_HEAD", "dep"])).not.toBe(await git(repo, ["ls-tree", baseSha, "dep"]))
    expect(await git(repo, ["ls-tree", "-r", "--name-only", "FETCH_HEAD"])).toContain("feature.txt")
  })

  it("refuses the pin half alone under the same gate, and leaves main untouched", async () => {
    const { repo, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
      carry: "pin-only",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, couplingSensitiveGate)
    const pr = await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha, baseSha })
    const mainBefore = await git(repo, ["rev-parse", "origin/main"])

    const run = (await app.queue.run({ prs: [pr.id] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    await git(repo, ["fetch", "-q", "origin", "main"])
    expect(await git(repo, ["rev-parse", "origin/main"])).toBe(mainBefore)
  })

  it("refuses the code half alone under the same gate, and leaves main untouched", async () => {
    const { repo, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "base",
      carry: "code-only",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, couplingSensitiveGate)
    const pr = await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha, baseSha })
    const mainBefore = await git(repo, ["rev-parse", "origin/main"])

    const run = (await app.queue.run({ prs: [pr.id] }, runtime))[0]!

    // The carrier never raises dep, so the queue leaves main's own entry in
    // place — base — and the gate's submodule clause fails. This also pins the
    // derive rule itself: an unraised submodule must NOT be advanced to its
    // main tip just because a newer commit exists there.
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    await git(repo, ["fetch", "-q", "origin", "main"])
    expect(await git(repo, ["rev-parse", "origin/main"])).toBe(mainBefore)
  })


  it("rejects an uncertified authored gitlink wrapper with intent-submission guidance", async () => {
    // Characterization narrowed by the (b) fill-in, in the same change as the
    // mechanism: a floor ON its submodule's main now composes (covered in
    // tests/composition-fill-in.test.ts), so the refusal this test pins — and
    // its needs-author routing — survives exactly for a floor that is NOT on
    // main, which candidateOffMain arranges. Re-merge Phase 1 gives this its
    // own code, `min-commit-unpublished`, split out of the broader
    // `authored-gitlink` per the Phase 0 design call (hub/yrd/2026-08-23-
    // remerge-phase0-replay.md) — a min-commit-not-on-main refusal is now
    // distinct from an added/removed gitlink, both still needs-author.
    const { repo, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
      candidateOffMain: true,
    })
    await git(repo, ["config", "diff.ignoreSubmodules", "all"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main", baseSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "min-commit-unpublished",
        message: expect.stringMatching(/'dep'.*is not on submodule main.*push it to the submodule's own main/su),
      },
    })
    expect(run.error?.message).not.toContain("yrd pr recut")
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: ".", paths: ["dep"] }] },
    })
    // End-to-end through the REAL compose path: the composition refusal commits
    // native needs-author with its typed result, never a terminal rejection.
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "needs-author" })
    const eventNames = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(eventNames).toContain("pr/needs-author")
    expect(eventNames).not.toContain("pr/rejected")
    const eligibility = app.queue.eligibility("PR1")
    expect(eligibility.reason?.code).toBe("needs-author")
    expect(eligibility.reason?.result).toMatchObject({ code: "min-commit-unpublished" })
  })

  it("puts a provisioned lockfile in the immutable pin candidate before checks run", async () => {
    const fixture = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    const issue = "@hh/tooling/manifest-gate-blind-to-pins"
    const priorPin = (await git(fixture.repo, ["ls-tree", fixture.baseSha, "dep"])).split(/\s+/u)[2]
    if (priorPin === undefined) throw new Error("fixture has no prior gitlink pin")
    const provisionalCandidates: string[] = []
    const prepare = gitCandidatePreparer({
      inject: { process },
      repo: fixture.repo,
      async provisionPinIntent({ path, provisionalCandidateSha }) {
        provisionalCandidates.push(provisionalCandidateSha)
        await writeFile(join(path, "bun.lock"), "generated for target manifest\n")
        return { generatedPaths: ["bun.lock"] }
      },
    })
    const pr = ChangeSnapshotSchema.parse({
      id: "yrdpin#1",
      branch: "intent/yrdpin#1",
      base: "main",
      issue,
      revision: 1,
      headSha: fixture.baseSha,
      baseSha: fixture.baseSha,
      intent: {
        id: "yrdpin#1",
        authored: {
          intentId: "00000000-0000-7000-8000-000000000021",
          issue: { source: "hh", id: issue },
          component: "dep",
          target: fixture.moduleSha,
        },
        evaluated: { priorPin, target: fixture.moduleSha },
      },
    })
    const prepared = await prepare({
      id: "C1",
      queueId: "main",
      baseSha: fixture.baseSha,
      revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
      prs: [pr],
    })
    if (prepared.sha === undefined || prepared.ref === undefined) {
      throw new Error("candidate preparation returned no immutable identity")
    }

    expect(provisionalCandidates).toHaveLength(1)
    expect(prepared.sha).not.toBe(provisionalCandidates[0])
    expect(await git(fixture.repo, ["rev-parse", prepared.ref])).toBe(prepared.sha)
    expect(await git(fixture.repo, ["rev-parse", `${prepared.sha}^`])).toBe(fixture.baseSha)
    expect(await git(fixture.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", prepared.sha])).toBe(
      "bun.lock\ndep",
    )
    expect(await git(fixture.repo, ["show", `${prepared.sha}:bun.lock`])).toBe("generated for target manifest")
    expect(await git(fixture.repo, ["ls-tree", prepared.sha, "dep"])).toContain(fixture.moduleSha)
  }, 30_000)

  it("refuses every provisioned path except the enumerated bun.lock", async () => {
    const fixture = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    const issue = "@hh/tooling/manifest-gate-blind-to-pins"
    const priorPin = (await git(fixture.repo, ["ls-tree", fixture.baseSha, "dep"])).split(/\s+/u)[2]
    if (priorPin === undefined) throw new Error("fixture has no prior gitlink pin")
    const pr = ChangeSnapshotSchema.parse({
      id: "yrdpin#2",
      branch: "intent/yrdpin#2",
      base: "main",
      issue,
      revision: 1,
      headSha: fixture.baseSha,
      baseSha: fixture.baseSha,
      intent: {
        id: "yrdpin#2",
        authored: {
          intentId: "00000000-0000-7000-8000-000000000024",
          issue: { source: "hh", id: issue },
          component: "dep",
          target: fixture.moduleSha,
        },
        evaluated: { priorPin, target: fixture.moduleSha },
      },
    })

    await expect(
      gitCandidatePreparer({
        inject: { process },
        repo: fixture.repo,
        async provisionPinIntent({ path }) {
          await writeFile(join(path, "generated.txt"), "must not enter the candidate\n")
          return { generatedPaths: ["generated.txt"] }
        },
      })({
        id: "C-forbidden",
        queueId: "main",
        baseSha: fixture.baseSha,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "wrapper-mismatch",
        message: expect.stringContaining("forbidden path(s) [generated.txt]; allowed [bun.lock]"),
      },
    })
  }, 30_000)


  /**
   * REGRESSION PIN, not a red-then-green: the guard this asserts already works.
   * `inspectBaseContainment` tests containment in BOTH directions — base ⊆ head
   * (up to date) and head ⊆ base (already merged, command.ts:2783-2786) — so a
   * SPENT carrier is not refused today. That second direction had no direct test,
   * which is what this closes.
   *
   * It is worth pinning because the branch reads like a redundant second
   * merge-base call, and deleting it would silently reintroduce the loop it
   * prevents: a spent carrier told to rebuild has nothing to rebuild, so each
   * recut is refused again. The convergence that would otherwise settle such a
   * carrier lives in `recut-absorbed-payload` (22373, "reaches an already-landed
   * head when the base absorbed the whole payload").
   */
  it("does not refuse a spent carrier whose head the base already contains", async () => {
    const { repo } = await repository()
    const originalBase = await git(repo, ["rev-parse", "main"])
    await git(repo, ["switch", "-qc", "issue/spent-carrier", originalBase])
    await writeFile(join(repo, "carrier.txt"), "carrier payload\n")
    await git(repo, ["add", "carrier.txt"])
    await git(repo, ["commit", "-qm", "carrier payload"])
    const carrierHead = await git(repo, ["rev-parse", "HEAD"])
    const carrierTree = await git(repo, ["rev-parse", "HEAD^{tree}"])
    await git(repo, ["switch", "-q", "main"])
    // The carrier's own head merges on main by another route, then main moves on.
    await git(repo, ["merge", "-q", "--no-ff", carrierHead, "-m", "merge the carrier payload"])
    await writeFile(join(repo, "later.txt"), "later work\n")
    await git(repo, ["add", "later.txt"])
    await git(repo, ["commit", "-qm", "later merge"])
    const queueBaseHead = await git(repo, ["rev-parse", "HEAD"])

    // The two facts that together define SPENT. `git()` throws on a non-zero
    // exit, so the ancestry call is itself the assertion.
    await git(repo, ["merge-base", "--is-ancestor", carrierHead, queueBaseHead])
    expect(await git(repo, ["log", "--oneline", `${carrierHead}..${queueBaseHead}`])).not.toBe("")

    await using process = createProcess()
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/spent-carrier",
      base: "main",
      revision: 2,
      headSha: carrierHead,
      baseSha: originalBase,
      // The containment check only runs for a carrier bearing a recut snapshot
      // (command.ts:2216), which is exactly the shape that loops: each hand-run
      // recut produces one of these and is refused again.
      recut: {
        fromRevision: 1,
        patchId: "a".repeat(40),
        treeSha: carrierTree,
        reviewCarried: false,
        baseSha: originalBase,
      },
    })

    // `CandidatePreparer` is declared sync-or-async (queue.ts), so the returned
    // union has no `.then` to call directly.
    const refusedCode = await Promise.resolve(
      gitCandidatePreparer({ inject: { process }, repo })({
        id: "C1",
        queueId: "main",
        baseSha: queueBaseHead,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      }),
    ).then(
      () => undefined,
      (error: unknown) => (error as { failure?: { code?: string } }).failure?.code,
    )

    expect(refusedCode).not.toBe("carrier-drops-landed")
  })

  /**
   * The residual case ancestry cannot reach. Every guard above this one asks
   * whether the carrier CONTAINS the base; this carrier does, and still erases a
   * merge. A criss-cross gives the carrier and the base two merge bases, `ort`
   * resolves against a virtual base built from both, and the deletion it resolves
   * appears in neither the conflict output nor the carrier's authored diff.
   */
  it("refuses a clean merge that deletes a merged path the carrier never authored deleting", async () => {
    const { repo } = await repository()
    const originalBase = await git(repo, ["rev-parse", "main"])

    // Two concurrent lines off the same base: one merges a file, one does not.
    await git(repo, ["switch", "-qc", "issue/sibling", originalBase])
    await writeFile(join(repo, "sibling.txt"), "sibling\n")
    await git(repo, ["add", "sibling.txt"])
    await git(repo, ["commit", "-qm", "sibling work"])
    const siblingSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-qc", "issue/mint", originalBase])
    await writeFile(join(repo, "merged-mint.md"), "mint\n")
    await git(repo, ["add", "merged-mint.md"])
    await git(repo, ["commit", "-qm", "merge the mint"])
    const mintSha = await git(repo, ["rev-parse", "HEAD"])

    // The queue base absorbs both, so the mint is merged work.
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["merge", "-q", "--no-ff", siblingSha, "-m", "merge sibling work"])
    await git(repo, ["merge", "-q", "--no-ff", mintSha, "-m", "merge the mint"])
    const queueBaseHead = await git(repo, ["rev-parse", "HEAD"])

    // The carrier absorbs the same two lines in the other order and resolves by
    // dropping the mint, then continues linearly so its tip is not a merge tip.
    await git(repo, ["switch", "-q", "issue/mint"])
    await git(repo, ["merge", "--no-ff", "--no-commit", siblingSha])
    await git(repo, ["rm", "-q", "merged-mint.md"])
    await git(repo, ["commit", "-qm", "recomposed tree drops the mint"])
    await writeFile(join(repo, "carrier.txt"), "carrier payload\n")
    await git(repo, ["add", "carrier.txt"])
    await git(repo, ["commit", "-qm", "carrier payload"])
    const carrierHead = await git(repo, ["rev-parse", "HEAD"])

    // The three facts that make this the residual case. `git()` throws on a
    // non-zero exit, so the ancestry call is itself the assertion that every
    // containment guard above passes this carrier.
    await git(repo, ["merge-base", "--is-ancestor", mintSha, carrierHead])
    expect(await git(repo, ["merge-base", "--all", queueBaseHead, carrierHead])).toContain("\n")
    const authoredBase = await git(repo, ["merge-base", queueBaseHead, carrierHead])
    expect(
      await git(repo, ["diff", "--no-renames", "--diff-filter=D", "--name-only", authoredBase, carrierHead, "--"]),
    ).toBe("")

    await using process = createProcess()
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/mint",
      base: "main",
      revision: 1,
      headSha: carrierHead,
      baseSha: originalBase,
    })

    await expect(
      gitCandidatePreparer({ inject: { process }, repo })({
        id: "C1",
        queueId: "main",
        baseSha: queueBaseHead,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "unauthored-path-deletion",
        message: expect.stringMatching(/merged-mint\.md.*authored diff.*merge current base/isu),
      },
    })
  })

  it("merges a carrier that authors its own deletion", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "doomed.txt"), "doomed\n")
    await git(repo, ["add", "doomed.txt"])
    await git(repo, ["commit", "-qm", "add the file the carrier will delete"])
    const queueBaseHead = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-qc", "issue/deleter", queueBaseHead])
    await git(repo, ["rm", "-q", "doomed.txt"])
    await git(repo, ["commit", "-qm", "delete the file on purpose"])
    const carrierHead = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])

    await using process = createProcess()
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/deleter",
      base: "main",
      revision: 1,
      headSha: carrierHead,
      baseSha: queueBaseHead,
    })

    const prepared = await gitCandidatePreparer({ inject: { process }, repo })({
      id: "C1",
      queueId: "main",
      baseSha: queueBaseHead,
      revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
      prs: [pr],
    })

    const { sha } = prepared
    if (sha === undefined) throw new Error("candidate preparation returned no sha")
    // README.md pins the tree read itself: without it, an empty listing would
    // satisfy the absence assertion below for the wrong reason.
    const tree = await git(repo, ["ls-tree", "-r", "--name-only", sha])
    expect(tree).toContain("README.md")
    expect(tree).not.toContain("doomed.txt")
  })


  /**
   * The content residual, and the shape `d416a3179e` rode: both parents carry a
   * distinct feature marker in the SAME file, the carrier's own resolution keeps
   * only its own marker, and the criss-cross makes the merge apply that
   * resolution against the virtual base. No path is deleted, so the deletion
   * guard cannot see it; nothing conflicts, so nobody is asked; a merged feature
   * is simply gone from a merge with full ancestry.
   */
  const NEUTRAL_LINES = Array.from({ length: 40 }, (_, index) => `export const line${index + 1} = ${index + 1}`)
  const FEATURE_ALPHA = 'export const FEATURE_ALPHA = "alpha"'
  const FEATURE_BETA = 'export const FEATURE_BETA = "beta"'
  /** Alpha at the top and beta at the bottom of forty neutral lines: far enough
   * apart that every merge below is a genuine clean auto-merge, never a conflict
   * this test resolved into the shape it wanted. */
  const featuresFile = (markers: Readonly<{ alpha?: boolean; beta?: boolean; doomed?: boolean }>): string =>
    [
      ...(markers.alpha === true ? [FEATURE_ALPHA] : []),
      ...NEUTRAL_LINES,
      ...(markers.doomed === true ? ['export const DOOMED = "doomed"'] : []),
      ...(markers.beta === true ? [FEATURE_BETA] : []),
    ].join("\n") + "\n"

  it("refuses a clean merge whose result drops a merged feature marker neither parent authored removing", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "features.ts"), featuresFile({}))
    await git(repo, ["add", "features.ts"])
    await git(repo, ["commit", "-qm", "the file both features merge in"])
    const originalBase = await git(repo, ["rev-parse", "HEAD"])

    // Two concurrent lines off the same base, each merge its own marker.
    await git(repo, ["switch", "-qc", "issue/alpha", originalBase])
    await writeFile(join(repo, "features.ts"), featuresFile({ alpha: true }))
    await git(repo, ["commit", "-qam", "merge the alpha feature"])
    const alphaSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-qc", "issue/beta", originalBase])
    await writeFile(join(repo, "features.ts"), featuresFile({ beta: true }))
    await git(repo, ["commit", "-qam", "merge the beta feature"])
    const betaSha = await git(repo, ["rev-parse", "HEAD"])

    // The queue base absorbs both, so BOTH markers are merged work.
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["merge", "-q", "--no-ff", alphaSha, "-m", "merge alpha"])
    await git(repo, ["merge", "-q", "--no-ff", betaSha, "-m", "merge beta"])
    const queueBaseHead = await git(repo, ["rev-parse", "HEAD"])

    // The carrier absorbs the same two lines in the other order and resolves by
    // keeping only its own marker, then continues linearly so its tip is not a
    // merge tip.
    await git(repo, ["switch", "-q", "issue/beta"])
    await git(repo, ["merge", "--no-ff", "--no-commit", alphaSha])
    await writeFile(join(repo, "features.ts"), featuresFile({ beta: true }))
    await git(repo, ["commit", "-qam", "recomposed tree keeps only beta"])
    await writeFile(join(repo, "carrier.txt"), "carrier payload\n")
    await git(repo, ["add", "carrier.txt"])
    await git(repo, ["commit", "-qm", "carrier payload"])
    const carrierHead = await git(repo, ["rev-parse", "HEAD"])

    // The facts that make this the residual case rather than any guard above it.
    // `git()` throws on a non-zero exit, so the ancestry call is itself the
    // assertion that the carrier contains the merged alpha commit.
    await git(repo, ["merge-base", "--is-ancestor", alphaSha, carrierHead])
    expect(await git(repo, ["merge-base", "--all", queueBaseHead, carrierHead])).toContain("\n")
    expect(await git(repo, ["show", `${queueBaseHead}:features.ts`])).toContain(FEATURE_ALPHA)
    expect(await git(repo, ["show", `${carrierHead}:features.ts`])).not.toContain(FEATURE_ALPHA)
    // Nothing is deleted and nothing conflicts, so neither residual guard that
    // exists today can witness the loss.
    expect(
      await git(repo, ["diff", "--no-renames", "--diff-filter=D", "--name-only", queueBaseHead, carrierHead, "--"]),
    ).toBe("")

    await using process = createProcess()
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/beta",
      base: "main",
      revision: 1,
      headSha: carrierHead,
      baseSha: originalBase,
    })

    await expect(
      gitCandidatePreparer({ inject: { process }, repo })({
        id: "C1",
        queueId: "main",
        baseSha: queueBaseHead,
        revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
        prs: [pr],
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "dropped-parent-contribution",
        // Order-independent on purpose: the refusal must name the file, the
        // exact line it lost, WHICH parent contributed it, and the remedy —
        // but which of those it says first is prose, not contract.
        message: expect.stringMatching(
          /(?=.*features\.ts)(?=.*FEATURE_ALPHA)(?=.*merge current base)(?=.*restore the dropped content)/isu,
        ),
      },
    })
  })

  /**
   * The control that keeps the witness from refusing honest work: the same
   * criss-cross, but the line the merge removes is one the carrier itself
   * removed on its own branch, against every merge base. Authorship, not
   * criss-cross-ness, is what the witness rules on.
   */
  it("merges a criss-cross merge whose removal the carrier itself authored, with both features intact", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "features.ts"), featuresFile({ doomed: true }))
    await git(repo, ["add", "features.ts"])
    await git(repo, ["commit", "-qm", "the file both features merge in"])
    const originalBase = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-qc", "issue/alpha", originalBase])
    await writeFile(join(repo, "features.ts"), featuresFile({ alpha: true, doomed: true }))
    await git(repo, ["commit", "-qam", "merge the alpha feature"])
    const alphaSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-qc", "issue/beta", originalBase])
    await writeFile(join(repo, "features.ts"), featuresFile({ beta: true, doomed: true }))
    await git(repo, ["commit", "-qam", "merge the beta feature"])
    const betaSha = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["merge", "-q", "--no-ff", alphaSha, "-m", "merge alpha"])
    await git(repo, ["merge", "-q", "--no-ff", betaSha, "-m", "merge beta"])
    const queueBaseHead = await git(repo, ["rev-parse", "HEAD"])

    // Same criss-cross; the resolution keeps both markers, and a separate,
    // ordinary commit removes the doomed line on purpose.
    await git(repo, ["switch", "-q", "issue/beta"])
    await git(repo, ["merge", "--no-ff", "--no-commit", alphaSha])
    await git(repo, ["commit", "-qm", "merge alpha into beta"])
    await writeFile(join(repo, "features.ts"), featuresFile({ alpha: true, beta: true }))
    await git(repo, ["commit", "-qam", "remove the doomed line on purpose"])
    const carrierHead = await git(repo, ["rev-parse", "HEAD"])
    expect(await git(repo, ["merge-base", "--all", queueBaseHead, carrierHead])).toContain("\n")

    await using process = createProcess()
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/beta",
      base: "main",
      revision: 1,
      headSha: carrierHead,
      baseSha: originalBase,
    })

    const prepared = await gitCandidatePreparer({ inject: { process }, repo })({
      id: "C1",
      queueId: "main",
      baseSha: queueBaseHead,
      revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
      prs: [pr],
    })

    const { sha } = prepared
    if (sha === undefined) throw new Error("candidate preparation returned no sha")
    const mergedFeatures = await git(repo, ["show", `${sha}:features.ts`])
    expect(mergedFeatures).toContain(FEATURE_ALPHA)
    expect(mergedFeatures).toContain(FEATURE_BETA)
    expect(mergedFeatures).not.toContain("DOOMED")
  })

  it("merges an ordinary merge that carries both parents' markers into the same file", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "features.ts"), featuresFile({}))
    await git(repo, ["add", "features.ts"])
    await git(repo, ["commit", "-qm", "the file both features merge in"])
    const originalBase = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-qc", "issue/alpha", originalBase])
    await writeFile(join(repo, "features.ts"), featuresFile({ alpha: true }))
    await git(repo, ["commit", "-qam", "merge the alpha feature"])
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["merge", "-q", "--no-ff", "issue/alpha", "-m", "merge alpha"])
    const queueBaseHead = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-qc", "issue/beta", originalBase])
    await writeFile(join(repo, "features.ts"), featuresFile({ beta: true }))
    await git(repo, ["commit", "-qam", "merge the beta feature"])
    const carrierHead = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])

    await using process = createProcess()
    const pr = ChangeSnapshotSchema.parse({
      id: "PR1",
      branch: "issue/beta",
      base: "main",
      revision: 1,
      headSha: carrierHead,
      baseSha: originalBase,
    })

    const prepared = await gitCandidatePreparer({ inject: { process }, repo })({
      id: "C1",
      queueId: "main",
      baseSha: queueBaseHead,
      revs: [{ pr: pr.id, n: pr.revision, head: pr.headSha }],
      prs: [pr],
    })

    const { sha } = prepared
    if (sha === undefined) throw new Error("candidate preparation returned no sha")
    const mergedFeatures = await git(repo, ["show", `${sha}:features.ts`])
    expect(mergedFeatures).toContain(FEATURE_ALPHA)
    expect(mergedFeatures).toContain(FEATURE_BETA)
  })

  it("refuses a payload touching configured refuse paths and names them with the configured reason", async () => {
    const { repo } = await repository()
    const baseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["switch", "-qc", "issue/pm-state"])
    await mkdir(join(repo, "@km"), { recursive: true })
    await mkdir(join(repo, "hub"), { recursive: true })
    await writeFile(join(repo, "@km", "note.md"), "state\n")
    await writeFile(join(repo, "hub", "plan.md"), "plan\n")
    await writeFile(join(repo, "code.ts"), "export {}\n")
    await git(repo, ["add", "."])
    await git(repo, ["commit", "-qm", "pm state + code"])
    const headSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"], {
      refuse: { paths: ["@", "hub/"], reason: "pm state lives in the sibling state repo — commit it there directly" },
    })
    await app.bays.submit({ branch: "issue/pm-state", headSha, base: "main", baseSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "refused-path",
        message: expect.stringMatching(/@km\/note\.md.*hub\/plan\.md.*sibling state repo/u),
      },
    })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: ".", paths: ["@km/note.md", "hub/plan.md"] }] },
    })
    expect(await git(repo, ["rev-parse", "main"])).toBe(baseSha)
  })

  it("passes a payload outside the armed refuse boundary", async () => {
    const { repo, candidate } = await repository("candidate")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"], { refuse: { paths: ["@", "hub/"] } })
    await app.bays.submit({ branch: "issue/candidate", headSha: candidate, base: "main", baseSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
  })


  it("renews one runner lease only on child progress and recovers a stalled child without merge", async () => {
    type CheckedCommand = AddStepResult<ChangeShape, "check", z.infer<typeof CommandEvidenceSchema>>
    const encoder = new TextEncoder()

    const controlledQueue = async () => {
      const cwd = await mkdtemp(join(tmpdir(), "yrd-command-lease-"))
      roots.push(cwd)
      const started = Promise.withResolvers<ProcessRequest>()
      const completed = Promise.withResolvers<ProcessResult>()
      const aborted = Promise.withResolvers<void>()
      const mergeRuns: string[] = []
      const process: Pick<Process, "run"> = {
        run(request) {
          request.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
          started.resolve(request)
          return completed.promise
        },
      }
      const bayJobs = createBayJobDefs(unusedWorkspace)
      const check = withStep(
        "check",
        configuredCommandStep<ChangeShape>({
          inject: { process },
          command: ["progressing-check"],
          cwd,
          purpose: "check",
          artifactRoot: join(cwd, "artifacts"),
        }),
        { revision: "progressing-check-v1", output: CommandEvidenceSchema },
      )
      const merge = withMerge(
        (_input: StepExecution<CheckedCommand>) => {
          mergeRuns.push("merge")
          const commit = "b".repeat(40)
          return {
            status: "completed",
            conclusion: "success" as const,
            output: {
              commit,
              baseSha: commit,
            },
          }
        },
        { revision: "merge-v1" },
      )
      const queue = withQueue({ steps: [check, merge] as const, resolveBaseSha: () => "c".repeat(40) })
      const base = pipe(
        createYrdDef(),
        withJobs({ definitions: [bayJobs, queue.jobDefs] }),
        withBays({ jobs: bayJobs }),
      )
      const app = await createYrd(queue(base), {
        inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
      })
      await app.bays.submit({ branch: "issue/progress", headSha: "a".repeat(40), base: "main" })
      return { aborted, app, completed, mergeRuns, started, [Symbol.asyncDispose]: () => app.close() }
    }

    const result = (stdout: string): ProcessResult => ({
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      durationMs: 60,
      timedOut: false,
    })
    await using progressing = await controlledQueue()
    const progressingRun = progressing.app.queue.run(
      { prs: ["PR1"] },
      { runner: "same-runner", leaseMs: 120, heartbeatMs: 30 },
    )
    const progressingRequest = await progressing.started.promise
    for (let tick = 1; tick <= 8; tick += 1) {
      progressingRequest.onOutput?.({ stream: "stdout", chunk: encoder.encode(`progress ${tick}\n`) })
      await Bun.sleep(20)
    }

    expect(await progressing.app.jobs.recover({ now: new Date().toISOString() })).toEqual([])
    progressing.completed.resolve(result("progress complete\n"))
    await expect(progressingRun).resolves.toEqual([
      expect.objectContaining({
        status: "completed",
        conclusion: "success",
        steps: expect.arrayContaining([expect.objectContaining({ name: "merge" })]),
      }),
    ])
    const heartbeatLeases = (await Array.fromAsync(progressing.app.events()))
      .filter(({ name }) => name === "job/transitioned")
      .map(({ data }) => data as { type?: string; leaseExpiresAt?: string })
      .filter(({ type }) => type === "heartbeat")
      .map(({ leaseExpiresAt }) => leaseExpiresAt)
    expect(heartbeatLeases.length).toBeGreaterThan(1)
    expect(progressing.mergeRuns).toEqual(["merge"])

    await using stalled = await controlledQueue()
    const stalledRun = stalled.app.queue.run(
      { prs: ["PR1"] },
      { runner: "same-runner", leaseMs: 200, heartbeatMs: 150 },
    )
    await stalled.started.promise
    await Bun.sleep(30)
    const recovered = await stalled.app.queue.recover({
      // Advance the operator's recovery cutoff beyond the still-live lease;
      // the habitant heartbeat has not yet sampled, so external recovery owns
      // this transition deterministically instead of racing self-settlement.
      recoveryTime: new Date(Date.now() + 1_000).toISOString(),
    })
    const ownershipAborted = await Promise.race([
      stalled.aborted.promise.then(() => true),
      Bun.sleep(250).then(() => false),
    ])
    stalled.completed.resolve(result("too late\n"))
    await stalledRun

    expect(ownershipAborted).toBe(true)
    expect(recovered).toEqual([
      expect.objectContaining({
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(stalled.mergeRuns).toEqual([])
  })

  it("persists candidate-conflict evidence on the causative check step before scratch cleanup", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "conflict.txt"), "base\n")
    await git(repo, ["add", "conflict.txt"])
    await git(repo, ["commit", "-qm", "conflict base"])
    await git(repo, ["switch", "-qc", "issue/conflict"])
    await writeFile(join(repo, "conflict.txt"), "feature\n")
    await git(repo, ["commit", "-qam", "conflicting feature"])
    const featureSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "conflict.txt"), "main\n")
    await git(repo, ["commit", "-qam", "conflicting main"])

    const artifactRoot = join(repo, ".git", "yrd", "artifacts")
    await using process = createProcess()
    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      command: ["true"],
      artifactRoot,
    })(
      {
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/conflict", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "candidate-conflict", message: expect.stringContaining("CONFLICT") },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") return
    const artifacts = (outcome.output as { artifacts?: readonly { name: string; path: string }[] } | undefined)
      ?.artifacts
    // Check steps preserve both terminal streams. The contract here is that
    // conflict evidence survives scratch cleanup, not that only one stream exists.
    expect(artifacts?.map(({ name }) => name)).toEqual(["stdout", "stderr"])
    if (artifacts === undefined) throw new Error("missing candidate-conflict artifacts")
    expect(artifacts.map(({ path }) => path)).toEqual([
      expect.stringMatching(/\/R1\/0-check\/attempt-1\/stdout\.log$/u),
      expect.stringMatching(/\/R1\/0-check\/attempt-1\/stderr\.log$/u),
    ])
    expect(artifacts.every(({ path }) => existsSync(path))).toBe(true)
    const artifactContents = await Promise.all(artifacts.map(({ path }) => readFile(path, "utf8")))
    expect(artifactContents.some((contents) => contents.includes("CONFLICT"))).toBe(true)
  })

  it("bypasses authored commit hooks only for queue-synthesized candidate commits", async () => {
    const { repo } = await repository()
    await git(repo, ["switch", "-qc", "issue/hooked"])
    await mkdir(join(repo, ".githooks"), { recursive: true })
    const hook = join(repo, ".githooks", "commit-msg")
    await writeFile(hook, '#!/bin/sh\necho "authored hook rejected generated merge" >&2\nexit 1\n')
    await chmod(hook, 0o755)
    await writeFile(join(repo, "feature.txt"), "feature\n")
    await git(repo, ["add", ".githooks/commit-msg", "feature.txt"])
    await git(repo, ["commit", "-qm", "feature with authored policy"])
    const featureSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["config", "core.hooksPath", ".githooks"])

    const authored = Bun.spawn(["git", "-C", repo, "commit", "--allow-empty", "-m", "authored commit"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [authoredCode, authoredStderr] = await Promise.all([authored.exited, new Response(authored.stderr).text()])
    expect(authoredCode).not.toBe(0)
    expect(authoredStderr).toContain("authored hook rejected generated merge")
    await git(repo, ["switch", "-q", "main"])

    await using process = createProcess()
    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      command: ["true"],
      artifactRoot: join(repo, ".git", "yrd", "artifacts"),
    })(
      {
        run: "R-hook",
        step: "check",
        index: 0,
        prs: [{ id: "PR-hook", branch: "issue/hooked", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      },
      { id: "J-hook", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("discloses an environment refusal in the attempt directory instead of leaving it empty", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const artifactRoot = join(repo, ".git", "yrd", "artifacts")
    const provisionDetail =
      "yrd: required check 'typecheck' workspace could not install its dependencies in /bays/warm/worktree; " +
      "bun install --frozen-lockfile --ignore-scripts child exited 1\n" +
      "error: lockfile had changes, but lockfile is frozen"
    await using process = createProcess()
    const refusingProcess: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "test") {
          throw createFailure({
            kind: "infrastructure",
            code: "candidate-provision-failed",
            message: provisionDetail,
          })
        }
        return process.run(request)
      },
    }

    const outcome = await gitCheckStep({
      inject: { process: refusingProcess },
      repo,
      command: ["test", "-f", "feature.txt"],
      artifactRoot,
      purpose: "typecheck",
    })(
      {
        run: "R-refused",
        step: "typecheck",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "queue-environment-refused" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") return
    const dir = join(artifactRoot, "R-refused", "0-typecheck", "attempt-1")
    expect((await readdir(dir)).toSorted()).toEqual(["error.json", "output.log", "terminal.json"])
    expect(JSON.parse(await readFile(join(dir, "error.json"), "utf8"))).toEqual(outcome.error)
    const disclosure = await readFile(join(dir, "output.log"), "utf8")
    expect(disclosure).toContain("queue-environment-refused")
    expect(disclosure).toContain("candidate-provision-failed")
    expect(disclosure).toContain("lockfile had changes, but lockfile is frozen")
    // 22896: no command ever ran here — the refusal fired before spawning one —
    // so exitCode/signal are null TOGETHER, distinct from a command that ran
    // and exited nonzero. Either shape beats today's silence, but conflating
    // them would misreport which one happened.
    const terminal = JSON.parse(await readFile(join(dir, "terminal.json"), "utf8"))
    expect(terminal).toMatchObject({ status: "failure", exitCode: null, signal: null, timedOut: false })
  })

  it("adds the typed error to a failing check without clobbering its command streams", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const artifactRoot = join(repo, ".git", "yrd", "artifacts")
    await using process = createProcess()

    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      command: shellCommand("echo checked-output; echo checked-diagnostic >&2; exit 1"),
      artifactRoot,
      purpose: "typecheck",
    })(
      {
        run: "R-red",
        step: "typecheck",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "typecheck-failed" } })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") return
    const dir = join(artifactRoot, "R-red", "0-typecheck", "attempt-1")
    expect((await readdir(dir)).toSorted()).toEqual([
      "error.json",
      "output.log",
      "stderr.log",
      "stdout.log",
      "terminal.json",
    ])
    expect(JSON.parse(await readFile(join(dir, "error.json"), "utf8"))).toEqual(outcome.error)
    expect(await readFile(join(dir, "stdout.log"), "utf8")).toContain("checked-output")
    expect(await readFile(join(dir, "output.log"), "utf8")).toContain("checked-diagnostic")
    // 22896: the command DID run and exit 1 — a reader must not have to guess
    // that from stream contents, and must not confuse it with a check that
    // never got as far as spawning a process at all.
    const terminal = CommandTerminalSchema.parse(JSON.parse(await readFile(join(dir, "terminal.json"), "utf8")))
    expect(terminal).toMatchObject({ status: "failure", exitCode: 1, signal: null, timedOut: false })
    expect(new Date(terminal.startedAt).getTime()).not.toBeNaN()
    expect(new Date(terminal.endedAt).getTime()).toBeGreaterThanOrEqual(new Date(terminal.startedAt).getTime())
  })

  it("checks the immutable Candidate already materialized by the Runner Context", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    const candidateRef = "refs/yrd/candidates/C1"
    await git(repo, ["update-ref", candidateRef, featureSha])
    const candidatePath = join(repo, "..", "candidate-C1")
    await git(repo, ["worktree", "add", "--detach", candidatePath, candidateRef])
    await using process = createProcess()
    const commandCwds: string[] = []
    const recordingProcess: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "test") {
          if (request.cwd === undefined) throw new Error("Candidate check command is missing its Context cwd")
          commandCwds.push(request.cwd)
        }
        return process.run(request)
      },
    }

    const outcome = await gitCheckStep({
      inject: { process: recordingProcess },
      repo,
      command: ["test", "-f", "feature.txt"],
    })(
      {
        run: "R1",
        step: "check",
        index: 0,
        prs: [
          {
            id: "PR1",
            branch: "issue/feature",
            base: "main",
            revision: 1,
            headSha: featureSha,
            baseSha,
          },
        ],
        candidate: {
          id: "C1",
          queueId: "main",
          baseSha,
          revs: [{ pr: "PR1", n: 1, head: featureSha }],
          sha: featureSha,
          ref: candidateRef,
          mergeability: "mergeable",
          createdAt: new Date(0).toISOString(),
        },
        shape: { results: {} },
      } as StepExecution<ChangeShape>,
      {
        id: "J1",
        attempt: 1,
        runner: "local",
        context: {
          id: "worktree-context:1",
          request: { scope: "job", candidate: "rw", capabilities: ["git"] },
          candidateRef,
          cwd: candidatePath,
        },
        signal: new AbortController().signal,
      },
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { baseSha, candidateSha: featureSha, candidateRef },
    })
    expect(commandCwds).toEqual([candidatePath])
  })

  it("defaults command artifacts under $GIT_DIR/yrd/artifacts, not cwd/.yrd-artifacts", async () => {
    const { repo } = await repository()
    const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"])
    const process: Pick<Process, "run"> = {
      run() {
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "ok\n",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        })
      },
    }
    const step = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: ["true"],
      cwd: repo,
      purpose: "check",
    })
    const outcome = await step(
      {
        run: "R-outside",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
        shape: { results: {} },
      },
      { id: "J-outside", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    expect(existsSync(join(repo, ".yrd-artifacts"))).toBe(false)
    expect(existsSync(join(gitDir, "yrd", "artifacts", "R-outside", "0-check", "attempt-1"))).toBe(true)
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("a real command run leaves the git work tree porcelain-empty", async () => {
    const { repo } = await repository()
    const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"])
    await using process = createProcess()
    const step = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: ["true"],
      cwd: repo,
      purpose: "check",
    })
    const outcome = await step(
      {
        run: "R-live",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
        shape: { results: {} },
      },
      { id: "J-live", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    expect(existsSync(join(repo, ".yrd-artifacts"))).toBe(false)
    expect(existsSync(join(gitDir, "yrd", "artifacts", "R-live", "0-check", "attempt-1"))).toBe(true)
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("refuses a missing artifactRoot when cwd is not a git work tree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-no-git-"))
    roots.push(cwd)
    const step = configuredCommandStep<ChangeShape>({
      inject: {
        process: {
          run() {
            return Promise.resolve({
              exitCode: 0,
              signal: null,
              stdout: "",
              stderr: "",
              durationMs: 1,
              timedOut: false,
            })
          },
        },
      },
      command: ["true"],
      cwd,
      purpose: "check",
    })
    await expect(
      step(
        {
          run: "R1",
          step: "check",
          index: 0,
          prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
          shape: { results: {} },
        },
        { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/not a git work tree|artifactRoot/)
  })

  it("executes argv directly and requires an explicit gate for shell text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-argv-"))
    roots.push(cwd)
    const requests: ProcessRequest[] = []
    const process: Pick<Process, "run"> = {
      run(request) {
        requests.push(request)
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        })
      },
    }
    const input = {
      run: "R1",
      step: "check",
      index: 0,
      prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
      shape: { results: {} },
    } as StepExecution<ChangeShape>
    const context = { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal }

    expect(() =>
      configuredCommandStep<ChangeShape>({
        inject: { process },
        command: "printf unsafe" as never,
        cwd,
        purpose: "check",
      }),
    ).toThrow("shellCommand")

    const artifactRoot = join(cwd, "artifacts")
    const direct = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: ["printf", "%s", "literal;$(not-expanded)"],
      cwd,
      purpose: "check",
      artifactRoot,
    })
    const explicitShell = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: shellCommand("printf shell"),
      cwd,
      purpose: "check",
      artifactRoot,
    })

    await direct(input, context)
    await explicitShell(input, context)
    expect(requests.map((request) => request.argv)).toEqual([
      ["printf", "%s", "literal;$(not-expanded)"],
      ["sh", "-c", "printf shell"],
    ])
    expect(requests.map((request) => request.noProgressTimeoutMs)).toEqual([undefined, undefined])
  })

  it("streams exact stdout and stderr artifacts before a configured command settles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-streaming-"))
    roots.push(cwd)
    const artifactRoot = join(cwd, "artifacts")
    const started = Promise.withResolvers<ProcessRequest>()
    const completed = Promise.withResolvers<ProcessResult>()
    const process: Pick<Process, "run"> = {
      run(request) {
        started.resolve(request)
        return completed.promise
      },
    }
    const step = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: ["streaming-check"],
      cwd,
      purpose: "check",
      artifactRoot,
    })
    const input = {
      run: "R-stream",
      step: "check",
      index: 0,
      prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
      shape: { results: {} },
    } as StepExecution<ChangeShape>
    const context = { id: "J-stream", attempt: 2, runner: "test", signal: new AbortController().signal }
    let settled = false
    const running = Promise.resolve(step(input, context)).finally(() => {
      settled = true
    })
    const request = await started.promise
    const encoder = new TextEncoder()
    const stdout = encoder.encode("first € last\n")
    const stderr = encoder.encode("warning\n")
    const splitInsideCodePoint = encoder.encode("first ").byteLength + 1
    const dir = join(artifactRoot, "R-stream", "0-check", "attempt-2")
    const stdoutPath = join(dir, "stdout.log")
    const stderrPath = join(dir, "stderr.log")
    const outputPath = join(dir, "output.log")
    const offsets = new Map([
      ["stdout.log", 0],
      ["stderr.log", 0],
    ])
    const observedStreams: string[] = []
    const nextGrowth = async (filename: "stdout.log" | "stderr.log"): Promise<string> => {
      const offset = offsets.get(filename) ?? 0
      let length = offset
      await vi.waitFor(
        async () => {
          let bytes: Uint8Array
          try {
            bytes = await readFile(join(dir, filename))
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return
            throw cause
          }
          length = bytes.byteLength
          expect(length).toBeGreaterThan(offset)
        },
        { timeout: 5_000, interval: 10 },
      )
      offsets.set(filename, length)
      return filename.slice(0, -".log".length)
    }

    request.onOutput?.({ stream: "stdout", chunk: stdout.subarray(0, splitInsideCodePoint) })
    observedStreams.push(await nextGrowth("stdout.log"))
    await vi.waitFor(
      async () => {
        expect(Array.from(await readFile(stdoutPath))).toEqual(Array.from(stdout.subarray(0, splitInsideCodePoint)))
        expect(await readFile(outputPath, "utf8")).toBe("first ")
      },
      { timeout: 5_000, interval: 10 },
    )
    expect(settled).toBe(false)

    request.onOutput?.({ stream: "stderr", chunk: stderr })
    observedStreams.push(await nextGrowth("stderr.log"))
    await vi.waitFor(
      async () => {
        expect(Array.from(await readFile(stdoutPath))).toEqual(Array.from(stdout.subarray(0, splitInsideCodePoint)))
        expect(Array.from(await readFile(stderrPath))).toEqual(Array.from(stderr))
        expect(await readFile(outputPath, "utf8")).toBe("first warning\n")
      },
      { timeout: 5_000, interval: 10 },
    )
    expect(settled).toBe(false)

    request.onOutput?.({ stream: "stdout", chunk: stdout.subarray(splitInsideCodePoint) })
    observedStreams.push(await nextGrowth("stdout.log"))
    await vi.waitFor(
      async () => {
        expect(Array.from(await readFile(stdoutPath))).toEqual(Array.from(stdout))
        expect(await readFile(outputPath, "utf8")).toBe("first warning\n€ last\n")
      },
      { timeout: 5_000, interval: 10 },
    )
    expect(settled).toBe(false)
    expect(observedStreams).toEqual(["stdout", "stderr", "stdout"])

    completed.resolve({
      exitCode: 0,
      signal: null,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      durationMs: 10,
      timedOut: false,
    })
    await expect(running).resolves.toMatchObject({
      status: "completed",
      conclusion: "success",
      output: {
        artifacts: [
          { name: "stdout", path: stdoutPath },
          { name: "stderr", path: stderrPath },
        ],
      },
    })
    expect((await readdir(dir)).sort()).toEqual(["output.log", "stderr.log", "stdout.log", "terminal.json"])
    expect(Array.from(await readFile(stdoutPath))).toEqual(Array.from(stdout))
    expect(Array.from(await readFile(stderrPath))).toEqual(Array.from(stderr))
    expect(await readFile(outputPath, "utf8")).toBe("first warning\n€ last\n")
    // 22896: a GREEN check is exactly the case artifacts alone could never
    // distinguish from one still running or crashed silently — the terminal
    // record is what makes that distinction possible without the journal.
    const terminal = CommandTerminalSchema.parse(JSON.parse(await readFile(join(dir, "terminal.json"), "utf8")))
    expect(terminal).toMatchObject({ status: "success", exitCode: 0, signal: null, timedOut: false, durationMs: 10 })
    expect(new Date(terminal.startedAt).getTime()).not.toBeNaN()
    expect(new Date(terminal.endedAt).getTime()).toBeGreaterThanOrEqual(new Date(terminal.startedAt).getTime())
  }, 10_000)

  it("grows a real slow command artifact while the child is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-slow-stream-"))
    roots.push(cwd)
    const release = join(cwd, "release")
    const artifactRoot = join(cwd, "artifacts")
    const stdoutPath = join(artifactRoot, "R-slow", "0-check", "attempt-1", "stdout.log")
    const outputPath = join(artifactRoot, "R-slow", "0-check", "attempt-1", "output.log")
    await using process = createProcess()
    const step = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: shellCommand(
        "printf 'first\\n'; fixture_ticks=0; while [ ! -f \"$YRD_RELEASE\" ] && [ \"$fixture_ticks\" -lt 6000 ]; do fixture_ticks=$((fixture_ticks + 1)); sleep 0.01; done; printf 'second\\n'",
      ),
      cwd,
      purpose: "check",
      artifactRoot,
      variables: () => ({ YRD_RELEASE: release }),
    })
    let settled = false
    const running = Promise.resolve(
      step(
        {
          run: "R-slow",
          step: "check",
          index: 0,
          prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
          shape: { results: {} },
        },
        { id: "J-slow", attempt: 1, runner: "test", signal: new AbortController().signal },
      ),
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(
      async () => {
        expect(await readFile(stdoutPath, "utf8")).toBe("first\n")
        expect(await readFile(outputPath, "utf8")).toBe("first\n")
      },
      { timeout: 5_000, interval: 10 },
    )
    expect(settled).toBe(false)

    await writeFile(release, "go\n")
    await expect(running).resolves.toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { artifacts: [{ name: "stdout", path: stdoutPath }] },
    })
    expect(await readFile(stdoutPath, "utf8")).toBe("first\nsecond\n")
    expect(await readFile(outputPath, "utf8")).toBe("first\nsecond\n")
  }, 10_000)

  it.each([
    {
      name: "nonzero exit",
      process: {
        exitCode: 17,
        signal: null,
        stdout: "[yrd-base-health] base aaaaaaaaaaaa green\n",
        stderr: `src/index.ts(12,4): error TS2322: Type 'string' is not assignable\n M src/formatted.ts\n${"x".repeat(2_100)}`,
        durationMs: 321,
        timedOut: false,
      } satisfies ProcessResult,
      error: { code: "check-failed", message: "check command exited 17" },
      verdict: undefined,
    },
    {
      name: "stalled process",
      process: {
        exitCode: 137,
        signal: "SIGKILL" as const,
        stdout: "partial output\n",
        stderr: "stalled stderr\n",
        durationMs: 120_123,
        timedOut: false,
        stalled: true,
        verdict: "STALLED" as const,
        lastProgressAtMs: 17_500,
        lastProgressBytes: 42,
      } satisfies ProcessResult,
      error: { code: "check-stalled", message: "check stalled after 120000ms without progress" },
      verdict: "STALLED",
    },
  ])(
    "keeps $name errors concise while retaining durable command evidence",
    async ({ process: result, error, verdict }) => {
      const cwd = await mkdtemp(join(tmpdir(), "yrd-command-failure-"))
      roots.push(cwd)
      const step = configuredCommandStep<ChangeShape>({
        inject: { process: { run: () => Promise.resolve(result) } },
        command: ["false"],
        cwd,
        purpose: "check",
        artifactRoot: join(cwd, "artifacts"),
        ...(verdict === undefined ? {} : { noProgressTimeoutMs: 120_000 }),
      })
      const outcome = await step(
        {
          run: "R1",
          step: "check",
          index: 0,
          prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
          shape: { results: {} },
        },
        { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
      )

      expect(outcome).toMatchObject({ status: "completed", conclusion: "failure", error })
      if (outcome.status !== "completed" || outcome.conclusion !== "failure") {
        throw new Error(`configured command was ${outcome.status}`)
      }
      const evidence = CommandEvidenceSchema.parse(outcome.output)
      expect(evidence).toMatchObject({
        command: ["false"],
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        artifacts: [{ name: "stdout" }, { name: "stderr" }],
        ...(verdict === undefined ? {} : { stageVerdict: verdict }),
      })
      if (verdict === undefined) {
        expect(evidence.detail).toContain("[yrd-base-health]")
        expect(evidence.diagnostics).toEqual([
          {
            file: "src/index.ts",
            [sourceRowKey]: 12,
            column: 4,
            message: "error TS2322: Type 'string' is not assignable",
          },
          { file: "src/formatted.ts", [sourceRowKey]: 1, message: "working tree changed during check" },
        ])
      }
      expect(evidence.artifacts.every((artifact) => existsSync(artifact.path))).toBe(true)
      expect(outcome.error.message).not.toContain(evidence.detail ?? "")
      expect(outcome.error.message).not.toContain(cwd)
    },
  )

  it("surfaces an escaped-descendant stall as its OWN blocker, even with no output-progress lease configured", async () => {
    // The direct child exited (code 0) but a descendant held the output pipe
    // open past the post-exit drain grace, so @yrd/process abandoned the drain
    // and set `escapedDescendant`. This must fail DISTINCTLY from a plain stall,
    // and — unlike the output-progress stall — it must NOT depend on a
    // configured noProgressTimeoutMs (the drain grace is always armed).
    const result: ProcessResult = {
      exitCode: 0,
      signal: null,
      stdout: "started\n",
      stderr: "",
      durationMs: 2_345,
      timedOut: false,
      stalled: true,
      verdict: "STALLED",
      escapedDescendant: true,
      lastProgressAtMs: 12,
      lastProgressBytes: 8,
    } as ProcessResult
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-escaped-"))
    roots.push(cwd)
    const step = configuredCommandStep<ChangeShape>({
      inject: { process: { run: () => Promise.resolve(result) } },
      command: ["bun", "run", "check"],
      cwd,
      purpose: "check",
      artifactRoot: join(cwd, "artifacts"),
      // Deliberately NO noProgressTimeoutMs — proves the escaped branch is
      // independent of the output-progress lease.
    })
    const outcome = await step(
      {
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-stalled-escaped-descendant" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") {
      throw new Error(`configured command was ${outcome.status}`)
    }
    expect(outcome.error.message).toContain("descendant held its output pipe open")
    const evidence = CommandEvidenceSchema.parse(outcome.output)
    expect(evidence).toMatchObject({ escapedDescendant: true, stageVerdict: "STALLED", exitCode: 0 })
  })

  it("retains net-new failed configured-check output after Git candidate wrapping", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        "i=1; while test $i -le 55; do " +
          'printf \'src/base-%s.ts:1:1 - inherited-%s\\n\' "$i" "$i"; i=$((i + 1)); done; ' +
          "if test -f feature.txt; then printf 'src/feature.ts:2:1 - net-new\\n'; fi; " +
          "printf 'check stderr\\n' >&2; exit 17",
      ),
      { comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    if (run === undefined) throw new Error("missing integration run")
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    const job = run.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") throw new Error("check did not fail")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({
      exitCode: 17,
      baseSha,
      candidateRef: expectedCandidateRef("R1", "check", job.id, job.attempt, evidence.candidateSha),
      artifacts: [{ name: "stdout" }, { name: "stderr" }],
      comparison: {
        parent: { exitCode: 17 },
        netNewDiagnostics: [{ file: "src/feature.ts", [sourceRowKey]: 2, column: 1, message: "net-new" }],
        resolvedDiagnostics: [],
        unchangedDiagnosticCount: 55,
      },
    })
    expect(evidence.candidateSha).toHaveLength(40)
    expect(app.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: {
        code: "needs-author",
        result: {
          code: "check-failed",
          evidence: {
            kind: "candidate-attributed-check-failure",
            baseSha,
            candidateSha: evidence.candidateSha,
            failures: [{ file: "src/feature.ts", [sourceRowKey]: 2, column: 1, message: "net-new" }],
          },
        },
      },
    })
    expect(app.queue.eligibility("PR1").reason?.message).toContain("55 baseline errors unchanged")
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "needs-author",
      needsAuthor: { receipt: { code: "check-failed" } },
    })
    const eventNames = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(eventNames).toContain("pr/needs-author")
    expect(eventNames).not.toContain("pr/rejected")
    const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.name, artifact.path]))
    const stdoutArtifact = artifacts.get("stdout")
    const stderrArtifact = artifacts.get("stderr")
    if (stdoutArtifact === undefined || stderrArtifact === undefined) throw new Error("missing command artifacts")
    const candidateStdout = await readFile(stdoutArtifact, "utf8")
    expect(candidateStdout.split("\n").filter((row) => row.includes("inherited-"))).toHaveLength(55)
    expect(candidateStdout).toContain("src/feature.ts:2:1 - net-new\n")
    expect(await readFile(stderrArtifact, "utf8")).toBe("check stderr\n")
    const parentArtifacts = new Map(
      evidence.comparison?.parent.artifacts.map((artifact) => [artifact.name, artifact.path]),
    )
    const parentStdoutArtifact = parentArtifacts.get("stdout")
    const parentStderrArtifact = parentArtifacts.get("stderr")
    if (parentStdoutArtifact === undefined || parentStderrArtifact === undefined) {
      throw new Error("missing parent command artifacts")
    }
    const parentStdout = await readFile(parentStdoutArtifact, "utf8")
    expect(parentStdout.split("\n").filter((row) => row.includes("inherited-"))).toHaveLength(55)
    expect(parentStdout).not.toContain("net-new")
    expect(await readFile(parentStderrArtifact, "utf8")).toBe("check stderr\n")
  })

  it("does not run parent diagnostics comparison unless the step declares it", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let configuredRuns = 0
    const observed: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "sh") configuredRuns += 1
        return process.run(request)
      },
    }
    await using app = await checkedQueue(
      observed,
      repo,
      shellCommand("printf 'src/shared.ts:1:1 - shared diagnostic\\n'; exit 17"),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") {
      throw new Error("plain exit-code step did not fail")
    }
    expect(GitCheckEvidenceSchema.parse(job.output).comparison).toBeUndefined()
    expect(configuredRuns).toBe(1)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("passes parent-identical failed diagnostics regardless of order and duplicates", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        "if test -f feature.txt; then " +
          "printf '%s\\n' 'src/b.ts:2:1 - shared-b' 'src/a.ts:1:1 - shared-a' 'src/a.ts:1:1 - shared-a'; " +
          "else printf '%s\\n' 'src/a.ts:1:1 - shared-a' 'src/b.ts:2:1 - shared-b'; fi; exit 17",
      ),
      { comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("baseline-identical check did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)

    expect(evidence.exitCode).toBe(17)
    expect(evidence.comparison).toMatchObject({
      parent: { exitCode: 17 },
      netNewDiagnostics: [],
      resolvedDiagnostics: [],
    })
    expect(evidence.certificate).toMatchObject({
      version: 1,
      mode: "delta",
      baseSha,
      candidateSha: evidence.candidateSha,
      reports: [
        {
          version: 1,
          comparator: { id: "diagnostics", version: 1 },
          residual: { count: 2, hash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        },
      ],
    })
  })

  it("aggregates structured child residual reports into one auditable delta certificate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const firstHash = "a".repeat(64)
    const secondHash = "b".repeat(64)
    const report = (id: string, count: number, hash: string) =>
      `YRD-GATE-REPORT ${JSON.stringify({
        version: 1,
        comparator: { id, version: 1 },
        residual: { count, hash },
      })}`
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        `printf '%s\\n' '${report("bead-hygiene", 3, firstHash)}' '${report("affected-tests", 2, secondHash)}'`,
      ),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("structured child reports did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence.certificate).toEqual({
      version: 1,
      mode: "delta",
      baseSha,
      candidateSha: evidence.candidateSha,
      reports: [
        {
          version: 1,
          comparator: { id: "bead-hygiene", version: 1 },
          residual: { count: 3, hash: firstHash },
        },
        {
          version: 1,
          comparator: { id: "affected-tests", version: 1 },
          residual: { count: 2, hash: secondHash },
        },
      ],
    })
  })

  it("binds a checkpoint migration manifest to the exact Candidate certificate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const manifest = {
      version: 1,
      targetIdentity: "b".repeat(64),
      edges: [{ from: "a".repeat(64), to: "b".repeat(64) }],
    }
    const attestation = {
      version: 1,
      manifest,
      hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    }
    const trailer = `YRD-CHECKPOINT-MIGRATION ${JSON.stringify(attestation)}`
    await using app = await checkedQueue(process, repo, shellCommand(`printf '%s\n' '${trailer}'`), {
      checkpointIdentity: "a".repeat(64),
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("checkpoint migration attestation did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)

    expect(evidence.certificate).toMatchObject({
      version: 1,
      baseSha,
      candidateSha: evidence.candidateSha,
      checkpointMigration: attestation,
    })
  })

  it("reads the stored checkpoint identity at merge authority instead of queue construction", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let storedIdentity = "c".repeat(64)
    const manifest = {
      version: 1,
      targetIdentity: "b".repeat(64),
      edges: [{ from: "a".repeat(64), to: "b".repeat(64) }],
    }
    const trailer = `YRD-CHECKPOINT-MIGRATION ${JSON.stringify({
      version: 1,
      manifest,
      hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    })}`
    await using app = await checkedQueue(process, repo, shellCommand(`printf '%s\n' '${trailer}'`), {
      checkpointIdentity: () => storedIdentity,
    })
    storedIdentity = "a".repeat(64)
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("refuses a checkpoint migration certificate whose Candidate binding is stale", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const manifest = {
      version: 1,
      targetIdentity: "b".repeat(64),
      edges: [{ from: "a".repeat(64), to: "b".repeat(64) }],
    }
    const trailer = `YRD-CHECKPOINT-MIGRATION ${JSON.stringify({
      version: 1,
      manifest,
      hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    })}`
    const input = {
      run: "R1",
      step: "check",
      index: 0,
      prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
      shape: { results: {} },
    } satisfies StepExecution<ChangeShape>
    const checked = await gitCheckStep({
      inject: { process },
      repo,
      command: shellCommand(`printf '%s\n' '${trailer}'`),
    })(input, { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal })
    if (checked.status !== "completed" || checked.conclusion !== "success") {
      throw new Error("checkpoint migration check did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(checked.output)
    if (evidence.certificate === undefined) throw new Error("checkpoint migration check did not certify")
    const stale = GitCheckEvidenceSchema.parse({
      ...evidence,
      certificate: { ...evidence.certificate, candidateSha: baseSha },
    })

    const outcome = await gitMergeStep<Checked>({
      inject: { process },
      repo,
      checkpointIdentity: "a".repeat(64),
    })(
      { ...input, step: "merge", index: 1, shape: { results: { check: stale } } },
      { id: "J-merge", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "checkpoint-migration-certificate-stale" },
    })
  })

  it("binds the target-checkout checkpoint migration attestation to the Candidate certificate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const manifest = {
      version: 1 as const,
      targetIdentity: "b".repeat(64),
      edges: [{ from: "a".repeat(64), to: "b".repeat(64) }],
    }
    const observed: { path?: string; candidateSha?: string } = {}
    await using app = await checkedQueue(process, repo, shellCommand("true"), {
      checkpointIdentity: "a".repeat(64),
      async checkpointMigration({ path, candidate }) {
        observed.path = path
        observed.candidateSha = candidate.candidateSha
        return {
          version: 1,
          manifest,
          hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
        }
      },
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("target attestation did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)

    expect(observed.path).toContain("worktree")
    expect(observed.candidateSha).toBe(evidence.candidateSha)
    expect(evidence.certificate?.checkpointMigration?.manifest).toEqual(manifest)
  })

  it("refuses when the configured command and target assembly disagree on checkpoint identity", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const emittedManifest = { version: 1 as const, targetIdentity: "b".repeat(64), edges: [] }
    const generatedManifest = { version: 1 as const, targetIdentity: "c".repeat(64), edges: [] }
    const emitted = {
      version: 1 as const,
      manifest: emittedManifest,
      hash: createHash("sha256").update(JSON.stringify(emittedManifest)).digest("hex"),
    }
    const generated = {
      version: 1 as const,
      manifest: generatedManifest,
      hash: createHash("sha256").update(JSON.stringify(generatedManifest)).digest("hex"),
    }
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(`printf '%s\n' 'YRD-CHECKPOINT-MIGRATION ${JSON.stringify(emitted)}'`),
      { checkpointMigration: () => Promise.resolve(generated) },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-checkpoint-migration-surface-disagreement" },
    })
  })

  it("refuses merge when the Candidate omits checkpoint migration evidence", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, shellCommand("true"), {
      checkpointIdentity: "a".repeat(64),
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "checkpoint-migration-certificate-missing" },
    })
    expect(await git(repo, ["rev-parse", "main"])).not.toBe(featureSha)
  })

  it("refuses a certified checkpoint manifest without an exact path from the stored identity", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const manifest = {
      version: 1,
      targetIdentity: "b".repeat(64),
      edges: [{ from: "c".repeat(64), to: "b".repeat(64) }],
    }
    const trailer = `YRD-CHECKPOINT-MIGRATION ${JSON.stringify({
      version: 1,
      manifest,
      hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    })}`
    await using app = await checkedQueue(process, repo, shellCommand(`printf '%s\n' '${trailer}'`), {
      checkpointIdentity: "a".repeat(64),
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "checkpoint-migration-path-missing" },
    })
  })

  it.each([
    {
      name: "ambiguous",
      edges: [
        { from: "a".repeat(64), to: "b".repeat(64) },
        { from: "a".repeat(64), to: "c".repeat(64) },
      ],
      code: "checkpoint-migration-path-ambiguous",
    },
    {
      name: "cyclic",
      edges: [
        { from: "a".repeat(64), to: "c".repeat(64) },
        { from: "c".repeat(64), to: "a".repeat(64) },
      ],
      code: "checkpoint-migration-path-cyclic",
    },
  ])("refuses a $name certified checkpoint migration path", async ({ edges, code }) => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const manifest = { version: 1, targetIdentity: "b".repeat(64), edges }
    const trailer = `YRD-CHECKPOINT-MIGRATION ${JSON.stringify({
      version: 1,
      manifest,
      hash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    })}`
    await using app = await checkedQueue(process, repo, shellCommand(`printf '%s\n' '${trailer}'`), {
      checkpointIdentity: "a".repeat(64),
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code } })
  })

  it("fails the check when a checkpoint migration manifest hash is malformed", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const manifest = { version: 1, targetIdentity: "b".repeat(64), edges: [] }
    const trailer = `YRD-CHECKPOINT-MIGRATION ${JSON.stringify({
      version: 1,
      manifest,
      hash: "0".repeat(64),
    })}`
    await using app = await checkedQueue(process, repo, shellCommand(`printf '%s\n' '${trailer}'`))
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-checkpoint-migration-invalid" },
    })
  })

  it("keeps a structured child failure terminal instead of reinterpreting it as generic diagnostics", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let configuredRuns = 0
    const observed: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "sh") configuredRuns += 1
        return process.run(request)
      },
    }
    const report = `YRD-GATE-REPORT ${JSON.stringify({
      version: 1,
      comparator: { id: "affected-tests", version: 1 },
      residual: { count: 1, hash: "a".repeat(64) },
    })}`
    await using app = await checkedQueue(
      observed,
      repo,
      shellCommand(`printf '%s\\n' '${report}' 'src/shared.ts:1:1 - child-owned failure'; exit 17`),
      {
        comparison: "diagnostics",
        comparisonReady: DIAGNOSTICS_COMPARISON_READY,
        mode: "delta",
      },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    expect(configuredRuns).toBe(1)
  })

  it("compares final diagnostics only after structured children certify readiness", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const report = (id: string, count: number, hash: string) =>
      `YRD-GATE-REPORT ${JSON.stringify({
        version: 1,
        comparator: { id, version: 1 },
        residual: { count, hash },
      })}`
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        `printf '%s\\n' '${report("bead-hygiene", 3, "a".repeat(64))}' ` +
          `'${report("affected-tests", 2, "b".repeat(64))}' ` +
          `'${report(DIAGNOSTICS_COMPARISON_READY, 0, "c".repeat(64))}' ` +
          "'src/shared.ts:1:1 - inherited'; exit 17",
      ),
      {
        comparison: "diagnostics",
        comparisonReady: DIAGNOSTICS_COMPARISON_READY,
        mode: "delta",
      },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("certified compound diagnostics did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence.certificate?.reports.map(({ comparator, residual }) => [comparator.id, residual.count])).toEqual([
      ["bead-hygiene", 3],
      ["affected-tests", 2],
      [DIAGNOSTICS_COMPARISON_READY, 0],
      ["diagnostics", 1],
    ])
  })

  it("refuses diagnostics comparison when the declared readiness report is missing", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let configuredRuns = 0
    const observed: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "sh") configuredRuns += 1
        return process.run(request)
      },
    }
    await using app = await checkedQueue(
      observed,
      repo,
      shellCommand("printf 'src/shared.ts:1:1 - inherited\\n'; exit 17"),
      {
        comparison: "diagnostics",
        comparisonReady: DIAGNOSTICS_COMPARISON_READY,
        mode: "delta",
      },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    expect(configuredRuns).toBe(1)
  })

  it("refuses a green compound command that omits its declared readiness report", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, shellCommand("true"), {
      comparison: "diagnostics",
      comparisonReady: DIAGNOSTICS_COMPARISON_READY,
      mode: "delta",
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-comparison-not-ready" },
    })
  })

  it("fails closed when a child emits a malformed structured report", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, shellCommand("printf '%s\\n' 'YRD-GATE-REPORT {not-json}'"), {
      mode: "delta",
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-gate-report-invalid" },
    })
  })

  it("refuses a green strict command that reports a non-empty residual", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const report = `YRD-GATE-REPORT ${JSON.stringify({
      version: 1,
      comparator: { id: "bead-hygiene", version: 1 },
      residual: { count: 1, hash: "a".repeat(64) },
    })}`
    await using app = await checkedQueue(process, repo, shellCommand(`printf '%s\\n' '${report}'`), {
      mode: "strict",
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-strict-residual" } })
  })

  it("strict mode keeps an inherited diagnostics failure terminal and skips the parent run", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let configuredRuns = 0
    const observed: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "sh") configuredRuns += 1
        return process.run(request)
      },
    }
    await using app = await checkedQueue(
      observed,
      repo,
      shellCommand("printf 'src/shared.ts:1:1 - inherited\\n'; exit 17"),
      { comparison: "diagnostics", mode: "strict" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") {
      throw new Error("strict inherited failure did not fail")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence.mode).toBe("strict")
    expect(evidence.comparison).toBeUndefined()
    expect(configuredRuns).toBe(1)
  })

  it("passes a candidate without requiring its failing parent gate to pass", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand("if test -f feature.txt; then exit 0; else printf 'src/base.ts:7:3 - existing\\n'; exit 17; fi"),
      { comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("candidate-first check did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)

    expect(evidence.exitCode).toBe(0)
    expect(evidence.comparison).toBeUndefined()
  })

  it("fails terminally when declared diagnostics comparison cannot compare a real parent command failure", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        "if test -f feature.txt; then printf 'src/feature.ts:2:1 - net-new\\n'; " +
          "else printf 'opaque parent failure\\n'; fi; exit 17",
      ),
      { comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") {
      throw new Error("parent command failure did not fail the run")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({
      exitCode: 17,
      diagnostics: [{ file: "src/feature.ts", [sourceRowKey]: 2, column: 1, message: "net-new" }],
    })
    expect(evidence.comparison).toBeUndefined()
    expect(job.error).not.toHaveProperty("evidence")
    expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("keeps an incomplete parent diagnostics run retryable as infrastructure refusal", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let configuredRuns = 0
    const parentTimeout: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] !== "sh") return process.run(request)
        configuredRuns += 1
        if (configuredRuns === 1) return process.run(request)
        return Promise.resolve({
          exitCode: 124,
          signal: "SIGKILL",
          stdout: "",
          stderr: "parent bootstrap timed out",
          durationMs: 1_000,
          timedOut: true,
        })
      },
    }
    await using app = await checkedQueue(
      parentTimeout,
      repo,
      shellCommand("printf 'src/feature.ts:2:1 - net-new\\n'; exit 17"),
      { comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: {
          kind: "check-comparison-refusal",
          phase: "parent",
          error: { code: "check-timeout" },
          parent: { exitCode: 124, timedOut: true },
          candidateEvidence: { exitCode: 17 },
          retryable: true,
        },
      },
    })
    expect(configuredRuns).toBe(2)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it.each([false, true])(
    "classifies a SIGKILLed candidate check as retryable infrastructure, never a task verdict (waiting=%s)",
    async (waiting) => {
      const { repo, feature: featureSha } = await repository("feature")
      await using process = createProcess()
      const killed: Pick<Process, "run"> = {
        run(request) {
          if (request.argv[0] !== "sh") return process.run(request)
          return Promise.resolve({
            exitCode: 1,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
            durationMs: 100,
            timedOut: false,
          })
        },
      }
      await using app = await checkedQueue(killed, repo, shellCommand("exit 0"), { waiting })
      await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
      expect(run).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "queue-environment-refused",
          evidence: {
            kind: "check-execution-refusal",
            phase: "candidate",
            error: { code: "check-infrastructure-signal", message: expect.stringContaining("SIGKILL") },
            retryable: true,
          },
        },
      })
      expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
    },
  )

  it("treats Vitest-shaped nonzero output as a terminal failure under the plain exit-code contract", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        "printf '%s\\n' ' FAIL  tests/guard.test.ts > guard > rejects drift' " +
          "'AssertionError: expected true to be false' ' Test Files  1 failed (1)' >&2; exit 1",
      ),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") {
      throw new Error("Vitest-shaped failure did not fail the run")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({ exitCode: 1, detail: expect.stringContaining("Test Files  1 failed") })
    expect(evidence.diagnostics).toBeUndefined()
    expect(evidence.comparison).toBeUndefined()
    expect(job.error).not.toHaveProperty("evidence")
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("keeps an opaque candidate failure terminal when diagnostics comparison is declared", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let configuredRuns = 0
    const observed: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "sh") configuredRuns += 1
        return process.run(request)
      },
    }
    await using app = await checkedQueue(
      observed,
      repo,
      shellCommand("printf ' FAIL  tests/guard.test.ts > opaque candidate\\n' >&2; exit 1"),
      { comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "check-failed" } })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") {
      throw new Error("opaque Candidate did not fail")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({ exitCode: 1, detail: expect.stringContaining("opaque candidate") })
    expect(evidence.diagnostics).toBeUndefined()
    expect(evidence.comparison).toBeUndefined()
    expect(configuredRuns).toBe(1)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("keeps a thrown candidate command distinct as a retryable environment refusal", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let candidateAttempts = 0
    const unavailable: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "sh" && request.argv[2]?.includes("YRD_THROW_CANDIDATE")) {
          candidateAttempts += 1
          throw new Error("spawn EACCES")
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailable, repo, shellCommand("printf 'YRD_THROW_CANDIDATE\\n'"))
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: {
          kind: "check-execution-refusal",
          phase: "candidate",
          error: { code: "check-candidate-execution-unavailable", message: "spawn EACCES" },
          retryable: true,
        },
      },
    })
    expect(candidateAttempts).toBe(1)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("preserves a legacy R1 attempt ref when an empty journal reuses the display run id", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    const legacyRef = "refs/yrd/candidates/R1/check/attempt-1"
    await git(repo, ["update-ref", legacyRef, baseSha])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ id: "R1", status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)

    expect(evidence.candidateRef).toBe(expectedCandidateRef("R1", "check", job.id, job.attempt, evidence.candidateSha))
    expect(await git(repo, ["rev-parse", legacyRef])).toBe(baseSha)
    expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "integrated", headSha: featureSha })
  })

  it("preserves an occupied derived candidate ref and publishes the candidate under a fresh identity", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const occupiedSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    let occupiedRef: string | undefined
    const racingProcess: Pick<Process, "run"> = {
      async run(request) {
        if (
          occupiedRef === undefined &&
          request.argv[0] === "git" &&
          request.argv[3] === "update-ref" &&
          request.argv[4] === "--create-reflog" &&
          request.argv[5]?.startsWith("refs/yrd/candidates/")
        ) {
          occupiedRef = request.argv[5]
          await git(repo, ["update-ref", occupiedRef, occupiedSha])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(racingProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ id: "R1", status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    if (occupiedRef === undefined) throw new Error("candidate publication was not intercepted")

    expect(evidence.candidateRef).not.toBe(occupiedRef)
    expect(await git(repo, ["rev-parse", occupiedRef])).toBe(occupiedSha)
    expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "integrated", headSha: featureSha })
  })

  it("refuses bounded candidate ref exhaustion without rejecting or moving the submitted payload", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const occupiedSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const occupiedRefs: string[] = []
    const hostileProcess: Pick<Process, "run"> = {
      async run(request) {
        const ref = request.argv[5]
        if (
          request.argv[0] === "git" &&
          request.argv[3] === "update-ref" &&
          request.argv[4] === "--create-reflog" &&
          ref?.startsWith("refs/yrd/candidates/")
        ) {
          occupiedRefs.push(ref)
          await git(repo, ["update-ref", ref, occupiedSha])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(hostileProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ id: "R1", status: "waiting" })
    const job = run?.steps[0]?.job
    expect(job).toMatchObject({
      status: "waiting",
      token: expect.stringMatching(/^candidate-ref-refused:/u),
      detail: expect.stringContaining("collision identities"),
    })
    expect(occupiedRefs).toHaveLength(33)
    for (const ref of occupiedRefs) expect(await git(repo, ["rev-parse", ref])).toBe(occupiedSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("merges the exact audited candidate and its durable artifacts", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand('git config user.name "Changed After Check" && test -f feature.txt && echo checked'),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run.status).toBe("completed")
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("feature\n")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")

    const job = run.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    await expectMerged(repo, evidence)
    expect(evidence.exitCode).toBe(0)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toBe("checked\n")
  })

  it("closes an already-landed payload without minting a no-op merge commit", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await writeFile(join(repo, "base-only.txt"), "base-only\n")
    await git(repo, ["add", "base-only.txt"])
    await git(repo, ["commit", "-qm", "advance base before duplicate patch"])
    await git(repo, ["cherry-pick", featureSha])
    const equivalentBaseSha = await git(repo, ["rev-parse", "main"])
    const equivalentTreeSha = await git(repo, ["rev-parse", "main^{tree}"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: {
        commit: equivalentBaseSha,
        baseSha: equivalentBaseSha,
        alreadyLanded: {
          candidateSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
          candidateTreeSha: equivalentTreeSha,
          baseTreeSha: equivalentTreeSha,
        },
      },
    })
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "already-landed",
      state: "closed",
      merged: true,
      integration: { commit: equivalentBaseSha, baseSha: equivalentBaseSha },
      alreadyLanded: {
        candidateSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        candidateTreeSha: equivalentTreeSha,
        baseTreeSha: equivalentTreeSha,
      },
    })
    expect(await git(repo, ["rev-parse", "main"])).toBe(equivalentBaseSha)
  })

  it("retains configured-command evidence when the Git check wrapper fails", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        'printf "[yrd-base-health] base aaaaaaaaaaaa is red: test:fast failed\\n"; ' +
          'printf "src/base.ts:1:1 - baseline guard failure\\n" >&2; ' +
          "if test -f feature.txt; then " +
          'printf "src/model.ts:12:4 - error TS2322: type mismatch\\n" >&2; fi; exit 17',
      ),
      { classification: "base", comparison: "diagnostics" },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run.status).toBe("completed")
    const job = run.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") throw new Error("check did not fail")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({
      command: ["sh", "-c", expect.stringContaining("test:fast failed")],
      exitCode: 17,
      classification: "base",
      diagnostics: [
        { file: "src/base.ts", [sourceRowKey]: 1, column: 1, message: "baseline guard failure" },
        { file: "src/model.ts", [sourceRowKey]: 12, column: 4, message: "error TS2322: type mismatch" },
      ],
      comparison: {
        netNewDiagnostics: [
          { file: "src/model.ts", [sourceRowKey]: 12, column: 4, message: "error TS2322: type mismatch" },
        ],
        resolvedDiagnostics: [],
      },
      baseSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      candidateSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      candidateRef: expect.stringContaining("refs/yrd/candidates/"),
    })
    expect(evidence.detail).toContain("[yrd-base-health]")
    expect(evidence.artifacts.every((artifact) => existsSync(artifact.path))).toBe(true)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted" })
    const eligibility = app.queue.eligibility("PR1")
    expect(eligibility).toMatchObject({ reason: { code: "required-check-failed" } })
    expect(eligibility.reason).not.toHaveProperty("result")
    const eventNames = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(eventNames).not.toContain("pr/rejected")
    expect(eventNames).not.toContain("pr/needs-author")
  })

  it("merges from origin when the base has no local branch without moving detached HEAD", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["update-ref", "refs/remotes/origin/main", baseSha])
    await git(repo, ["switch", "-q", "--detach", featureSha])
    await git(repo, ["branch", "-D", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status).toBe("completed")
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(featureSha)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(baseSha)
    const job = run.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    await expectMerged(repo, GitCheckEvidenceSchema.parse(job.output))
  })

  it("drains from the authoritative queue base without touching dirty behind operator main", async () => {
    const branches = ["pr4", "pr5", "pr6", "pr7"] as const
    const { repo, pr4, pr5, pr6, pr7 } = await repository(...branches)
    const heads = { pr4, pr5, pr6, pr7 }
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", ...branches.map((branch) => `issue/${branch}`)])
    await git(repo, ["switch", "-qc", "issue/remote-main"])
    await writeFile(join(repo, "remote-main.txt"), "authoritative\n")
    await git(repo, ["add", "remote-main.txt"])
    await git(repo, ["commit", "-qm", "remote main"])
    const initialQueueBase = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["push", "-q", "origin", "HEAD:main"])
    await git(repo, ["switch", "-q", "main"])
    const sentinel = join(repo, "operator-wip.txt")
    await writeFile(sentinel, "preserve these bytes\n")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    for (const branch of branches) {
      await app.bays.submit({ branch: `issue/${branch}`, headSha: heads[branch], base: "main" })
    }
    const operatorSnapshot = async () => ({
      headSha: await git(repo, ["rev-parse", "--verify", "HEAD"]),
      headIdentityState: await git(repo, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"]),
      status: await git(repo, ["status", "--porcelain", "--untracked-files=all"]),
      sentinelBytes: await readFile(sentinel, "utf8"),
    })
    const operatorBefore = await operatorSnapshot()
    expect(operatorBefore.headIdentityState).toContain("# branch.head main")
    expect(operatorBefore.status).toBe("?? operator-wip.txt")
    expect(operatorBefore.sentinelBytes).toBe("preserve these bytes\n")

    const runs = await app.queue.run({ prs: [] }, runtime)

    expect(runs).toHaveLength(branches.length)
    expect(runs.map((run) => [run.status, run.conclusion, run.error?.code])).toEqual([
      ["completed", "success", undefined],
      ["completed", "success", undefined],
      ["completed", "success", undefined],
      ["completed", "success", undefined],
    ])
    expect(
      runs.flatMap((run) => run.steps.map((step) => step.job?.attempt)).filter((attempt) => attempt !== undefined),
    ).toEqual(Array.from({ length: branches.length * 2 }, () => 1))
    const checks = runs.map((run) => {
      const job = run.steps[0]?.job
      if (job?.status !== "completed" || job.conclusion !== "success") {
        throw new Error(`run '${run.id}' check did not pass`)
      }
      return GitCheckEvidenceSchema.parse(job.output)
    })
    expect(checks[0]?.baseSha).toBe(initialQueueBase)
    for (let index = 1; index < runs.length; index += 1) {
      expect(checks[index]?.baseSha).toBe(runs[index - 1]?.integration?.commit)
    }
    const finalMerge = runs.at(-1)?.integration?.commit
    expect(finalMerge).toBeDefined()
    expect(await git(remote, ["rev-parse", "main"])).toBe(finalMerge)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(finalMerge)
    expect(await operatorSnapshot()).toEqual(operatorBefore)
  }, 15_000)

  it("refreshes authoritative remote base divergence and evaluates the unchanged payload", async () => {
    const { repo, feature: featureSha, competing: remoteBaseSha } = await repository("feature", "competing")
    const localBaseSha = await git(repo, ["rev-parse", "main"])
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature", "issue/competing"])
    await git(repo, ["push", "-q", "origin", `${remoteBaseSha}:refs/heads/main`])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    const job = run.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    expect(GitCheckEvidenceSchema.parse(job.output).baseSha).toBe(remoteBaseSha)
    expect(await git(repo, ["rev-parse", "main"])).toBe(localBaseSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "integrated",
    })
  })

  it("retries authoritative refresh at most three times without changing the change payload", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let recoveryAttempts = 0
    let recovered = false
    const refreshArgv: string[][] = []
    const flakyProcess: Pick<Process, "run"> = {
      run(request) {
        const refresh = request.argv[0] === "git" && request.argv.includes("fetch")
        if (refresh && !recovered) {
          refreshArgv.push([...request.argv])
          recoveryAttempts += 1
          if (recoveryAttempts < 3) {
            return Promise.resolve({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "temporary origin failure",
              durationMs: 1,
              timedOut: false,
            })
          }
          recovered = true
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(flakyProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(recoveryAttempts).toBe(3)
    expect(refreshArgv.every((argv) => argv.includes("--no-recurse-submodules"))).toBe(true)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "integrated",
    })
  })

  it("retries thrown authoritative refresh timeouts without rejecting the change", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let refreshAttempts = 0
    let recovered = false
    const flakyProcess: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch") && !recovered) {
          refreshAttempts += 1
          if (refreshAttempts < 3) return Promise.resolve(gitFetchTimeout)
          recovered = true
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(flakyProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(refreshAttempts).toBe(3)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "integrated",
    })
  })

  it("records exhausted thrown authority timeouts as environment refusal without rejecting the change", async () => {
    const stderrSpy = vi.spyOn(globalThis.process.stderr, "write").mockImplementation(() => true)
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let refreshAttempts = 0
    const unavailableOrigin: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          refreshAttempts += 1
          return Promise.resolve(gitFetchTimeout)
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailableOrigin, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(refreshAttempts).toBe(3)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("circuit breaker open after 3 consecutive timeouts"))
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        message: expect.stringContaining("after 3 attempts"),
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
    })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
    })
    expect(run.steps[0]?.job).not.toHaveProperty("output")
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "submitted",
    })
  })

  it("records exhausted authority refresh as an environment refusal without rejecting the author", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let refreshAttempts = 0
    const unavailableOrigin: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          refreshAttempts += 1
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "origin unavailable",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailableOrigin, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(refreshAttempts).toBe(3)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
    })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
    })
    expect(run.steps[0]?.job).not.toHaveProperty("output")
    expect(app.queue.checks(["PR1"])).toMatchObject([
      {
        error: {
          code: "queue-environment-refused",
          evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
        },
      },
    ])
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "submitted",
    })
    expect(await git(repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/candidates"])).toBe("")
  })

  it("keeps the submitted payload when native merge cannot refresh post-push authority", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let successfulRefreshes = 0
    let refusalAttempts = 0
    const unavailableAfterPush: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          if (successfulRefreshes < 2) {
            successfulRefreshes += 1
            return process.run(request)
          }
          refusalAttempts += 1
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "origin unavailable after native push",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailableAfterPush, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(successfulRefreshes).toBe(2)
    expect(refusalAttempts).toBe(3)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        message: expect.stringContaining("after 3 attempts"),
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    expect(run.steps[1]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        message: expect.stringContaining("after 3 attempts"),
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
    })
    expect(run.steps[1]?.job).not.toHaveProperty("output")
    expect(app.queue.checks(["PR1"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "merge",
          error: expect.objectContaining({
            code: "queue-environment-refused",
            evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
          }),
        }),
      ]),
    )
    expect(await git(remote, ["rev-parse", "main"])).toBe(checked.candidateSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "submitted",
    })
  })

  it("materializes candidate checks under the injected trusted parent", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const parentRoot = await mkdtemp(join(tmpdir(), "yrd-queue-checkouts-"))
    const checkoutParent = join(parentRoot, "nested")
    roots.push(parentRoot)
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["pwd"], { checkoutParent })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const job = run.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toMatch(
      new RegExp(`^${await realpath(checkoutParent)}/yrd-queue-`),
    )
  })

  it("fails the check when its detached scratch worktree and reachability stores cannot be removed", async () => {
    const { repo, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    const cleanupFailure: ProcessResult = {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "cleanup denied",
      durationMs: 1,
      timedOut: false,
    }
    const guarded = {
      run(request: Parameters<Process["run"]>[0]) {
        return request.argv.includes("remove") && request.argv.includes("worktree")
          ? Promise.resolve(cleanupFailure)
          : process.run(request)
      },
    }
    await using app = await checkedQueue(guarded, repo, ["test", "-f", "feature.txt"], {
      checkoutParent: join(repo, "..", "checkouts"),
    })
    await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "scratch-cleanup-failed", message: "cleanup denied" },
    })
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted" })
    const eventNames = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(eventNames).not.toContain("pr/rejected")
    expect(eventNames).not.toContain("pr/needs-author")
  })

  it("passes exact YRD_* variables while scrubbing ambient YRD_* and GIT_* values", async () => {
    await using process = createProcess()
    expect(() =>
      configuredCommandStep<ChangeShape>({
        inject: { process },
        command: ["echo", "{target}"],
        cwd: ".",
        purpose: "check",
      }),
    ).toThrow("placeholder {target} is retired; use $YRD_TARGET")

    const { repo } = await repository()
    const headSha = "a".repeat(40)
    const baseSha = "b".repeat(40)
    const pr = { id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha, baseSha }
    const step = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: shellCommand("env | grep -E '^(YRD_|GIT_)' | sort"),
      cwd: repo,
      purpose: "check",
      env: { ...globalThis.process.env, YRD_LEAK: "must-not-leak", GIT_DIR: "/must/not/leak" },
      // The asserted order needs byte collation; ambient LC_*/LANG are allowlisted
      // ambient state, so the deterministic-environment contract (merge-queue R42)
      // requires DECLARING it instead of inheriting whatever launched the runner.
      environmentOverrides: { LC_ALL: "C" },
      variables: () => ({ YRD_CUSTOM: "custom" }),
    })
    const result = await step(
      { run: "R1", step: "check", index: 0, prs: [pr], shape: { results: {} } },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    if (result.status !== "completed" || result.conclusion !== "success") {
      throw new Error(`configured command was ${result.status}`)
    }
    expect(result.output.detail?.split("\n")).toEqual([
      "YRD_ATTEMPT=1",
      "YRD_BASE=main",
      `YRD_BASE_SHA=${baseSha}`,
      "YRD_CUSTOM=custom",
      "YRD_GATE_MODE=delta",
      "YRD_JOB=J1",
      "YRD_PR=PR1",
      'YRD_PRS=["PR1"]',
      "YRD_RUN=R1",
      "YRD_RUNNER=test",
      `YRD_SHA=${headSha}`,
      `YRD_SHAS=["${headSha}"]`,
      "YRD_STEP=check",
      `YRD_TARGET=${headSha}`,
    ])
    expect(result.output.detail).not.toContain("YRD_LEAK")
    expect(result.output.detail).not.toContain("GIT_DIR")
  })

  describe("deterministic child environment (merge-queue R42)", () => {
    const headSha = "a".repeat(40)
    const execution = (): StepExecution<ChangeShape> =>
      ({
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha }],
        shape: { results: {} },
      }) as StepExecution<ChangeShape>
    const jobContext = (overrides: Readonly<{ id?: string; attempt?: number; runner?: string }> = {}) => ({
      id: "J1",
      attempt: 1,
      runner: "test",
      signal: new AbortController().signal,
      ...overrides,
    })
    const capturingProcess = () => {
      const requests: ProcessRequest[] = []
      const process: Pick<Process, "run"> = {
        run(request) {
          requests.push(request)
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          })
        },
      }
      return { requests, process }
    }
    const ambient: NodeJS.ProcessEnv = {
      PATH: "/deterministic/bin",
      HOME: "/deterministic/home",
      SHELL: "/bin/zsh",
      TMPDIR: "/deterministic/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      USER: "runner",
      LOGNAME: "runner",
      AMBIENT_JUNK: "must-not-leak",
      NODE_ENV: "production",
      DEBUG: "must-not-leak",
    }
    const runCapture = async (
      options: Readonly<{
        env: NodeJS.ProcessEnv
        environmentOverrides?: Readonly<Record<string, string>>
        environmentPassthrough?: readonly string[]
        variables?: () => Readonly<Record<string, string | undefined>>
      }>,
      context = jobContext(),
    ) => {
      const { requests, process } = capturingProcess()
      const artifactRoot = await mkdtemp(join(tmpdir(), "yrd-env-artifacts-"))
      roots.push(artifactRoot)
      const step = configuredCommandStep<ChangeShape>({
        inject: { process },
        command: ["check-env"],
        cwd: ".",
        purpose: "check",
        artifactRoot,
        ...options,
      })
      const result = await step(execution(), context)
      if (result.status !== "completed" || result.conclusion !== "success") {
        throw new Error(`configured command was ${result.status}`)
      }
      const request = requests[0]
      if (request === undefined) throw new Error("configured command spawned no child")
      return { env: request.env ?? {}, evidence: result.output }
    }

    it("drops every ambient value outside the base toolchain allowlist", async () => {
      const { env } = await runCapture({ env: ambient })
      expect(env).toMatchObject({
        PATH: "/deterministic/bin",
        HOME: "/deterministic/home",
        SHELL: "/bin/zsh",
        TMPDIR: "/deterministic/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        USER: "runner",
        LOGNAME: "runner",
      })
      expect(env.AMBIENT_JUNK).toBeUndefined()
      expect(env.NODE_ENV).toBeUndefined()
      expect(env.DEBUG).toBeUndefined()
    })

    it("applies declared environment values over the allowlisted ambient set", async () => {
      const { env } = await runCapture({
        env: ambient,
        environmentOverrides: { LANG: "C.UTF-8", NODE_ENV: "test" },
      })
      expect(env.LANG).toBe("C.UTF-8")
      expect(env.NODE_ENV).toBe("test")
    })

    it("snapshots declared overrides at construction so later mutation is never applied", async () => {
      const { requests, process } = capturingProcess()
      const overrides: Record<string, string> = { SAFE_DECLARED: "yes" }
      const artifactRoot = await mkdtemp(join(tmpdir(), "yrd-env-artifacts-"))
      roots.push(artifactRoot)
      const step = configuredCommandStep<ChangeShape>({
        inject: { process },
        command: ["check-env"],
        cwd: ".",
        purpose: "check",
        artifactRoot,
        env: ambient,
        environmentOverrides: overrides,
      })
      // Post-construction mutation of the caller-owned object must not reach
      // the child: reserved prefixes would have been refused at construction,
      // and undeclared names never went through validation at all.
      overrides.GIT_DIR = "/evil"
      overrides.YRD_ENVIRONMENT = "evil"
      overrides.SNEAKED = "in"
      overrides.SAFE_DECLARED = "mutated"
      const result = await step(execution(), jobContext())
      if (result.status !== "completed" || result.conclusion !== "success") {
        throw new Error(`configured command was ${result.status}`)
      }
      const env = requests[0]?.env ?? {}
      expect(env.SAFE_DECLARED).toBe("yes")
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.YRD_ENVIRONMENT).toBeUndefined()
      expect(env.SNEAKED).toBeUndefined()
    })

    it("copies only declared passthrough names from the ambient environment", async () => {
      const { env } = await runCapture({
        env: { ...ambient, CHECK_TOKEN: "declared", CHECK_OTHER: "undeclared" },
        environmentPassthrough: ["CHECK_TOKEN"],
      })
      expect(env.CHECK_TOKEN).toBe("declared")
      expect(env.CHECK_OTHER).toBeUndefined()
    })

    it("refuses reserved or malformed environment declarations at construction", () => {
      const { process } = capturingProcess()
      const construct = (
        options: Readonly<{
          environmentOverrides?: Readonly<Record<string, string>>
          environmentPassthrough?: readonly string[]
        }>,
      ) =>
        configuredCommandStep<ChangeShape>({
          inject: { process },
          command: ["check-env"],
          cwd: ".",
          purpose: "check",
          ...options,
        })
      expect(() => construct({ environmentPassthrough: ["GIT_DIR"] })).toThrow("GIT_DIR")
      expect(() => construct({ environmentPassthrough: ["YRD_PR"] })).toThrow("YRD_PR")
      expect(() => construct({ environmentOverrides: { YRD_CUSTOM: "x" } })).toThrow("YRD_CUSTOM")
      expect(() => construct({ environmentOverrides: { GIT_CONFIG: "x" } })).toThrow("GIT_CONFIG")
      expect(() => construct({ environmentOverrides: { "BAD NAME": "x" } })).toThrow("BAD NAME")
    })

    it("stamps evidence with a stable applied-environment identity", async () => {
      const passthroughEnv = { ...ambient, CHECK_TOKEN: "declared" }
      const first = await runCapture({ env: passthroughEnv, environmentPassthrough: ["CHECK_TOKEN"] })
      const second = await runCapture({ env: passthroughEnv, environmentPassthrough: ["CHECK_TOKEN"] })
      expect(first.evidence.environmentHash).toMatch(/^[0-9a-f]{64}$/u)
      expect(second.evidence.environmentHash).toBe(first.evidence.environmentHash)

      // Volatile per-execution coordinates (job id, attempt, runner) never move
      // the identity across retries of identical inputs.
      const retried = await runCapture(
        { env: passthroughEnv, environmentPassthrough: ["CHECK_TOKEN"] },
        jobContext({ id: "J2", attempt: 2, runner: "other" }),
      )
      expect(retried.evidence.environmentHash).toBe(first.evidence.environmentHash)

      // Dropped ambient junk never moves the identity.
      const junkMoved = await runCapture({
        env: { ...passthroughEnv, AMBIENT_JUNK: "different" },
        environmentPassthrough: ["CHECK_TOKEN"],
      })
      expect(junkMoved.evidence.environmentHash).toBe(first.evidence.environmentHash)

      // Any APPLIED change — allowlisted, passthrough, or declared — is visible.
      const allowlistedMoved = await runCapture({
        env: { ...passthroughEnv, LANG: "C" },
        environmentPassthrough: ["CHECK_TOKEN"],
      })
      expect(allowlistedMoved.evidence.environmentHash).not.toBe(first.evidence.environmentHash)
      const passthroughMoved = await runCapture({
        env: { ...passthroughEnv, CHECK_TOKEN: "rotated" },
        environmentPassthrough: ["CHECK_TOKEN"],
      })
      expect(passthroughMoved.evidence.environmentHash).not.toBe(first.evidence.environmentHash)
      const declaredMoved = await runCapture({
        env: passthroughEnv,
        environmentPassthrough: ["CHECK_TOKEN"],
        environmentOverrides: { CHECK_MODE: "strict" },
      })
      expect(declaredMoved.evidence.environmentHash).not.toBe(first.evidence.environmentHash)
    })

    it("treats applied YRD_* variables as environment, excluding only the enumerated volatile coordinates", async () => {
      const options = { env: ambient }
      const first = await runCapture(options)

      // Semantic config.environment flows in as YRD_ENVIRONMENT — an APPLIED
      // value, so changing it moves the identity.
      const staging = await runCapture({
        ...options,
        variables: () => ({ YRD_ENVIRONMENT: "staging" }),
      })
      expect(staging.evidence.environmentHash).not.toBe(first.evidence.environmentHash)
      const production = await runCapture({
        ...options,
        variables: () => ({ YRD_ENVIRONMENT: "production" }),
      })
      expect(production.evidence.environmentHash).not.toBe(staging.evidence.environmentHash)

      // A configured YRD_CUSTOM callback value is APPLIED environment too.
      const customA = await runCapture({ ...options, variables: () => ({ YRD_CUSTOM: "a" }) })
      const customB = await runCapture({ ...options, variables: () => ({ YRD_CUSTOM: "b" }) })
      expect(customA.evidence.environmentHash).not.toBe(first.evidence.environmentHash)
      expect(customA.evidence.environmentHash).not.toBe(customB.evidence.environmentHash)

      // The volatile set is the ONLY YRD_ exclusion: any non-listed YRD_X
      // participates in the hash.
      const nonListed = await runCapture({ ...options, variables: () => ({ YRD_X: "1" }) })
      expect(nonListed.evidence.environmentHash).not.toBe(first.evidence.environmentHash)
      // ...while a listed coordinate (e.g. YRD_CANDIDATE_REF) does not.
      const volatileOnly = await runCapture({
        ...options,
        variables: () => ({ YRD_CANDIDATE_REF: "refs/yrd/candidates/R1/check/attempt-9-feed" }),
      })
      expect(volatileOnly.evidence.environmentHash).toBe(first.evidence.environmentHash)
    })

    it("gives check children the declared environment, never the runner's ambient junk", async () => {
      const { repo, feature: featureSha } = await repository("feature")
      await using process = createProcess()
      await using app = await checkedQueue(process, repo, shellCommand("env | grep -E '^CHECK_' | sort || true"), {
        env: { ...globalThis.process.env, CHECK_JUNK: "must-not-leak", CHECK_TOKEN: "ambient-token" },
        environmentOverrides: { CHECK_DECLARED: "yes" },
        environmentPassthrough: ["CHECK_TOKEN"],
      })
      await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
      expect(run.status).toBe("completed")
      const job = run.steps[0]!.job
      if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
      const evidence = GitCheckEvidenceSchema.parse(job.output)
      expect(evidence.detail?.split("\n")).toEqual(["CHECK_DECLARED=yes", "CHECK_TOKEN=ambient-token"])
    })
  })

  it("checks and merges one combined candidate for a passing batch", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand("test -f one.txt && test -f two.txt && echo checked-batch"),
      { batch: 2 },
    )
    await app.bays.submit({ branch: "issue/one", headSha: firstSha, base: "main" })
    await app.bays.submit({ branch: "issue/two", headSha: secondSha, base: "main" })
    await git(repo, ["switch", "-q", "--detach", "main"])

    const runs = await app.queue.run({ prs: ["PR1", "PR2"] }, runtime)
    await git(repo, ["switch", "-q", "main"])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
      prs: [{ headSha: firstSha }, { headSha: secondSha }],
    })
    const job = runs[0]!.steps[0]!.job
    if (job?.status !== "completed" || job.conclusion !== "success") throw new Error("check did not pass")
    await expectMerged(repo, GitCheckEvidenceSchema.parse(job.output))
  })

  it("proves a regenerated code merge by Change-Id when the submitted SHA is absent from base ancestry", async () => {
    const { repo } = await repository()
    const changeId = `I${"1".repeat(40)}`
    const otherChangeId = `I${"2".repeat(40)}`

    await git(repo, ["switch", "-qc", "issue/authored"])
    await writeFile(join(repo, "payload.txt"), "same logical change\n")
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", `authored change\n\nChange-Id: ${changeId}`])
    const submittedHead = await git(repo, ["rev-parse", "HEAD"])

    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "payload.txt"), "same logical change\n")
    await git(repo, ["add", "payload.txt"])
    await git(repo, ["commit", "-qm", `queue-regenerated change\n\nChange-Id: ${changeId}`])
    const landingSha = await git(repo, ["rev-parse", "HEAD"])

    await expect(git(repo, ["merge-base", "--is-ancestor", submittedHead, landingSha])).rejects.toThrow()
    await using process = createProcess()
    await expect(
      findRepositoryChangeMerge({
        inject: { process },
        repo,
        baseSha: landingSha,
        identity: { changeId, submittedHead },
      }),
    ).resolves.toEqual({
      status: "proven",
      fact: { changeId, submittedHead, landingSha, baseSha: landingSha },
    })
    await expect(
      findRepositoryChangeMerge({
        inject: { process },
        repo,
        baseSha: landingSha,
        identity: { changeId: otherChangeId, submittedHead },
      }),
    ).resolves.toEqual({ status: "not-proven", reason: "change-id-not-on-base" })
  })

  it("checks and merges the exact Change-Id-stamped Candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"], {
      prepareCandidate: true,
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    const pr = app.state().bays.prs.PR1
    if (pr === undefined) throw new Error("expected PR1")
    const changeId = currentChangeRev(pr).changeId
    if (changeId === undefined) throw new Error("expected PR1 Change-Id")

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    if (run === undefined) throw new Error("expected Queue run")
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") {
      throw new Error("check did not pass")
    }
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(await git(repo, ["show", "-s", "--format=%B", checked.candidateSha])).toContain(`Change-Id: ${changeId}`)
    if (run.integration === undefined) {
      throw new Error(`merge produced no IntegrationProof: ${JSON.stringify(run.error)}`)
    }
    const integration = IntegrationProofSchema.parse(run.integration)
    expect(integration).toMatchObject({ commit: checked.candidateSha, baseSha: checked.candidateSha })

    expect(app.state().bays.prs.PR1?.integration).toEqual({
      commit: checked.candidateSha,
      baseSha: checked.candidateSha,
      changeId,
    })
    await expect(
      findRepositoryMergeRecords({
        inject: { process },
        repo,
        baseSha: checked.candidateSha,
        selector: "PR1",
      }),
    ).resolves.toMatchObject({
      status: "proven",
      records: [
        {
          record: {
            merge: { id: run.id, result: "merged", mergedCommit: checked.candidateSha },
            changes: [
              {
                changeId,
                pr: "PR1",
                revision: 1,
                submittedHead: featureSha,
                generatedCommit: checked.candidateSha,
              },
            ],
          },
        },
      ],
    })
  })

  it("marks the synthesized merge commit with a distinct Merge-Change-Id, never a second Change-Id", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"], {
      prepareCandidate: true,
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    const pr = app.state().bays.prs.PR1
    if (pr === undefined) throw new Error("expected PR1")
    const changeId = currentChangeRev(pr).changeId
    if (changeId === undefined) throw new Error("expected PR1 Change-Id")

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    if (run === undefined) throw new Error("expected Queue run")
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") {
      throw new Error("check did not pass")
    }
    const candidateSha = GitCheckEvidenceSchema.parse(checkJob.output).candidateSha

    expect(await git(repo, ["show", "-s", "--format=%(trailers:key=Merge-Change-Id,valueonly)", candidateSha])).toBe(
      `${changeId}-merge`,
    )
    // The distinct trailer must not widen what the Change-Id ancestry proof sees: one value, still.
    expect(await git(repo, ["show", "-s", "--format=%(trailers:key=Change-Id,valueonly)", candidateSha])).toBe(changeId)
    await expect(
      findRepositoryChangeMerge({
        inject: { process },
        repo,
        baseSha: candidateSha,
        identity: { changeId, submittedHead: featureSha },
      }),
    ).resolves.toMatchObject({ status: "proven", fact: { changeId, landingSha: candidateSha } })
  })

  it("persists one failed merge record with the reason, evidence, and fix", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand("printf 'candidate contract failed\\n' >&2; exit 17"),
      { prepareCandidate: true },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    if (run === undefined) throw new Error("expected Queue run")
    expect(run).toMatchObject({ status: "completed", conclusion: "failure" })

    const listed = await git(repo, ["notes", "--ref=yrd/merge-records", "list"])
    const [noteObject, target, extra] = listed.split(" ")
    expect(noteObject).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(target).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(extra).toBeUndefined()
    expect(JSON.parse(await git(repo, ["notes", "--ref=yrd/merge-records", "show", target!]))).toMatchObject({
      schema: "yrd/merge-record/v1",
      record: {
        merge: { id: run.id, result: "failed" },
        changes: [{ pr: "PR1", revision: 1, submittedHead: featureSha }],
        reason: { code: run.error?.code },
        evidence: { jobs: expect.arrayContaining([expect.objectContaining({ result: "failure" })]) },
        fix: expect.any(String),
      },
    })
    await expect(
      findRepositoryMergeRecords({
        inject: { process },
        repo,
        baseSha: await git(repo, ["rev-parse", "main"]),
        selector: "PR1",
      }),
    ).resolves.toMatchObject({
      status: "proven",
      records: [
        {
          record: { merge: { id: run.id, result: "failed" }, reason: { code: run.error?.code } },
          pointer: { ref: "refs/notes/yrd/merge-records", target, note: noteObject },
        },
      ],
    })
  })

  it("persists one canceled merge record when an active attempt is canceled", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(`printf '%s\\n' '{"token":"cancel-me","detail":"queued"}'`),
      { waiting: true },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const active = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    if (active === undefined) throw new Error("expected active Queue run")
    await app.queue.cancelRun({ run: active.id, by: "operator", reason: "superseded by a newer attempt" })

    const listed = await git(repo, ["notes", "--ref=yrd/merge-records", "list"])
    const target = listed.split(" ")[1]
    expect(target).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(JSON.parse(await git(repo, ["notes", "--ref=yrd/merge-records", "show", target!]))).toMatchObject({
      schema: "yrd/merge-record/v1",
      record: {
        merge: { id: active.id, result: "canceled" },
        changes: [{ pr: "PR1", revision: 1, submittedHead: featureSha }],
        reason: { code: "run-canceled", message: "Queue run canceled by operator: superseded by a newer attempt" },
        fix: expect.any(String),
      },
    })
  })

  it("merges the checked candidate through origin without touching a dirty local base checkout", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    const localMain = await git(repo, ["rev-parse", "main"])
    await writeFile(join(repo, "operator-wip.txt"), "preserve me\n")

    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    const mergeJob = run.steps[1]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: checked.candidateSha, baseSha: checked.candidateSha },
    })
    expect(mergeJob).toMatchObject({ status: "completed", conclusion: "success", attempt: 1, output: run.integration })
    expect(await git(remote, ["rev-parse", "main"])).toBe(checked.candidateSha)
    const mergeRecordRows = await git(remote, ["notes", "--ref=yrd/merge-records", "list"])
    const mergeRecordTarget = mergeRecordRows.split(" ")[1]
    expect(mergeRecordTarget).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(
      JSON.parse(await git(remote, ["notes", "--ref=yrd/merge-records", "show", mergeRecordTarget!])),
    ).toMatchObject({
      schema: "yrd/merge-record/v1",
      record: { merge: { id: run.id, result: "merged", mergedCommit: checked.candidateSha } },
    })
    expect(await git(repo, ["rev-parse", "main"])).toBe(localMain)
    expect(await Bun.file(join(repo, "operator-wip.txt")).text()).toBe("preserve me\n")
  })

  it("reports the Git cause when a remote merge-record ref cannot be materialized", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await git(repo, ["notes", "--ref=yrd/merge-records", "add", "-m", "seed remote record", "main"])
    await git(repo, ["push", "-q", "origin", "refs/notes/yrd/merge-records"])

    await using process = createProcess()
    let failedFetches = 0
    const unavailableRecordRef: Pick<Process, "run"> = {
      run(request) {
        if (
          request.argv[0] === "git" &&
          request.argv[3] === "fetch" &&
          request.argv.some((argument) => argument.includes("refs/notes/yrd/merge-record-upstream/"))
        ) {
          failedFetches += 1
          return Promise.resolve({
            exitCode: 41,
            signal: null,
            stdout: "",
            stderr: "fatal: merge-record transport unavailable",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailableRecordRef, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    await expect(app.queue.run({ prs: ["PR1"] }, runtime)).rejects.toThrow("fatal: merge-record transport unavailable")
    expect(failedFetches).toBe(1)
  })

  it("distinguishes a successful merge-record fetch whose staging ref is missing", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await git(repo, ["notes", "--ref=yrd/merge-records", "add", "-m", "seed remote record", "main"])
    await git(repo, ["push", "-q", "origin", "refs/notes/yrd/merge-records"])
    const remoteTip = await git(remote, ["rev-parse", "refs/notes/yrd/merge-records"])

    await using process = createProcess()
    let incompleteFetches = 0
    const missingStagingRef: Pick<Process, "run"> = {
      run(request) {
        if (
          request.argv[0] === "git" &&
          request.argv[3] === "fetch" &&
          request.argv.some((argument) => argument.includes("refs/notes/yrd/merge-record-upstream/"))
        ) {
          incompleteFetches += 1
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(missingStagingRef, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    await expect(app.queue.run({ prs: ["PR1"] }, runtime)).rejects.toThrow(
      `yrd: remote merge-record ref '${remoteTip}' fetched into ` +
        `'refs/notes/yrd/merge-record-upstream/${remoteTip}' but resolved to 'missing'`,
    )
    expect(incompleteFetches).toBe(1)
  })

  it("groups reachable non-tip candidate pins by origin in fresh exact-SHA proof stores", async () => {
    const { repo, featureSha, origin, pins } = await groupedSubmoduleRepository()
    await using process = createProcess()
    const requests: ProcessRequest[] = []
    const traced: Pick<Process, "run"> = {
      run(request) {
        requests.push(request)
        return process.run(request)
      },
    }
    await using app = await checkedQueue(traced, repo, ["true"])
    await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion, run.error?.message).toBe("success")
    expect(await git(origin, ["rev-parse", "main"])).toBe(pins[1])
    expect((run.integration as unknown as { componentMains?: unknown }).componentMains).toEqual([
      expect.objectContaining({ action: "fast-forwarded", path: "dep-a", pinSha: pins[1] }),
      expect.objectContaining({ action: "fast-forwarded", path: "dep-b", pinSha: pins[0] }),
    ])
    // Union behavior: queue Git operations lock the shared repository, so the
    // timeout-robustness lineage owns the 120s default across the whole proof.
    expect(
      requests
        .filter(({ argv, timeoutMs }) => argv[0] === "git" && argv.length > 1 && timeoutMs !== 120_000)
        .map(({ argv, timeoutMs }) => ({ argv, timeoutMs })),
    ).toEqual([])
    const initializations = requests.filter(
      ({ argv }) => argv[0] === "git" && argv.includes("init") && argv.includes("--bare") && argv.includes("--quiet"),
    )
    const proofFetches = requests.filter(({ argv }) => argv.includes("--depth=1") && argv.includes("--filter=tree:0"))
    expect(initializations).toHaveLength(1)
    expect(initializations[0]?.argv).toEqual(
      expect.arrayContaining(["init", "--bare", "--quiet", expect.stringMatching(/^--template=/u)]),
    )
    expect(proofFetches).toHaveLength(2)
    expect(proofFetches.map(({ argv }) => argv.at(-2))).toEqual([origin, origin])
    expect(
      proofFetches.map(({ argv }) => argv.at(-1)).toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual([...pins].toSorted((left, right) => left.localeCompare(right)))
    const proofStores = new Set(proofFetches.map(({ argv }) => argv[2]))
    expect([...proofStores]).toEqual([initializations[0]?.argv.at(-1)])

    const checkIndex = requests.findIndex(({ argv }) => argv[0] === "true")
    const materializeIndex = requests.findIndex(({ argv }) => argv.includes("submodule") && argv.includes("update"))
    expect(checkIndex).toBeGreaterThan(-1)
    expect(materializeIndex).toBeGreaterThan(checkIndex)
  }, 15_000)

  it.each([
    ["./dep.git", "https://example.test/org/super.git/dep.git"],
    ["../dep.git", "https://example.test/org/dep.git"],
  ] as const)("distinguishes Git-relative submodule URL %s", (relativeUrl, expected) => {
    expect(resolveRelativeSubmoduleOrigin("https://example.test/org/super.git", relativeUrl)).toBe(expected)
  })

  it("falls back to a plain shallow exact-SHA fetch only when filtering is unsupported", async () => {
    const { repo, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    const requests: ProcessRequest[] = []
    const unsupported: Pick<Process, "run"> = {
      run(request) {
        requests.push(request)
        if (request.argv.includes("--filter=tree:0")) {
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "fatal: filtering not recognized by server, aborting",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unsupported, repo, ["true"])
    await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status).toBe("completed")
    const proofFetches = requests.filter(({ argv }) => argv.includes("--depth=1"))
    expect(proofFetches).toHaveLength(2)
    expect(proofFetches[0]?.argv).toContain("--filter=tree:0")
    expect(proofFetches[1]?.argv).not.toContain("--filter=tree:0")
    expect(proofFetches[0]?.argv.at(-1)).toBe(proofFetches[1]?.argv.at(-1))
  }, 15_000)

  it.each([
    {
      name: "DNS transport failure",
      exitCode: 128,
      signal: null,
      stderr: "fatal: unable to access remote: Could not resolve host",
      timedOut: false,
    },
    {
      name: "timeout",
      exitCode: 124,
      signal: null,
      stderr: "fatal: filtering not recognized by server",
      timedOut: true,
    },
    {
      name: "signal termination",
      exitCode: 143,
      signal: "SIGTERM",
      stderr: "",
      timedOut: false,
    },
    {
      name: "unadvertised-object policy refusal",
      exitCode: 1,
      signal: null,
      stderr: "fatal: Server does not allow request for unadvertised object",
      timedOut: false,
    },
    {
      name: "unadvertised remote-ref refusal",
      exitCode: 1,
      signal: null,
      stderr: "fatal: couldn't find remote ref deadbeef",
      timedOut: false,
    },
    {
      name: "stalled filter-like probe",
      exitCode: 143,
      signal: null,
      stderr: "fatal: filtering not recognized by server",
      timedOut: false,
      stalled: true,
      verdict: "STALLED",
      sweepFailure: "process tree remained alive",
    },
  ] as const)(
    "keeps the candidate submitted after a cannot-probe $name",
    async (failure) => {
      const fixture = await hookedSubmoduleRepository({
        baseVersion: "base",
        candidateVersion: "candidate",
        requiredVersion: "candidate",
      })
      await using process = createProcess()
      const requests: ProcessRequest[] = []
      let configuredCheckRan = false
      const unavailable: Pick<Process, "run"> = {
        run(request) {
          requests.push(request)
          if (request.argv[0] === "true") configuredCheckRan = true
          if (request.argv.includes("--filter=tree:0")) {
            const base = {
              exitCode: failure.exitCode,
              signal: failure.signal,
              stdout: "",
              stderr: failure.stderr,
              durationMs: 1,
            }
            if ("stalled" in failure) {
              return Promise.resolve({
                ...base,
                timedOut: false,
                stalled: true,
                verdict: "STALLED",
                lastProgressAtMs: 17_500,
                lastProgressBytes: 42,
                sweepFailure: failure.sweepFailure,
              } satisfies ProcessResult)
            }
            return Promise.resolve(
              failure.timedOut
                ? ({ ...base, timedOut: true } satisfies ProcessResult)
                : ({ ...base, timedOut: false } satisfies ProcessResult),
            )
          }
          return process.run(request)
        },
      }
      await using app = await checkedQueue(unavailable, fixture.repo, ["true"])
      await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      expect(run).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "queue-environment-refused",
          evidence: {
            kind: "submodule-reachability-refusal",
            operation: "filtered-fetch",
            sha: fixture.moduleSha,
            exitCode: failure.exitCode,
            timedOut: failure.timedOut,
            signal: failure.signal,
            ...("stalled" in failure
              ? {
                  stalled: failure.stalled,
                  verdict: failure.verdict,
                  sweepFailure: failure.sweepFailure,
                }
              : {}),
            retryable: true,
          },
        },
      })
      expect(configuredCheckRan).toBe(false)
      // git-super retries a STALLED read-only git call (3652bfe), so a probe that
      // times out is attempted more than once. The exact count is git-super's retry
      // policy, not yrd's contract: asserting it here would hand-sync someone else's
      // constant into this suite and break on the next policy change. Assert the
      // property that matters -- the probe happened, and retrying stayed bounded.
      const depthProbes = requests.filter(({ argv }) => argv.includes("--depth=1"))
      expect(depthProbes.length).toBeGreaterThanOrEqual(1)
      expect(depthProbes.length).toBeLessThanOrEqual(5)
      expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
        status: "submitted",
        headSha: fixture.featureSha,
      })
    },
    15_000,
  )

  it.each([
    {
      name: "candidate tree timeout",
      operation: "read-tree",
      matches: (argv: readonly string[]) => argv.includes("ls-tree") && argv.includes("--full-tree"),
      exitCode: 124,
      signal: null,
      stderr: "candidate tree read timed out",
      timedOut: true,
    },
    {
      name: "gitmodules tool failure",
      operation: "read-gitmodules",
      matches: (argv: readonly string[]) => argv.includes("--blob"),
      exitCode: 128,
      signal: null,
      stderr: "fatal: could not read object database",
      timedOut: false,
    },
    {
      name: "silent gitmodules command failure",
      operation: "read-gitmodules",
      matches: (argv: readonly string[]) => argv.includes("--blob"),
      exitCode: 1,
      signal: null,
      stderr: "",
      timedOut: false,
    },
    {
      name: "local post-fetch bad-object verification",
      operation: "verify",
      matches: (argv: readonly string[]) => argv.includes("cat-file") && argv.includes("-e"),
      exitCode: 128,
      signal: null,
      stderr: "fatal: bad object deadbeef^{commit}",
      timedOut: false,
    },
    {
      name: "superproject origin signal termination",
      operation: "read-superproject-origin",
      matches: (argv: readonly string[]) => argv.at(-1) === "remote.origin.url",
      exitCode: 143,
      signal: "SIGTERM",
      stderr: "",
      timedOut: false,
    },
    {
      name: "silent superproject origin tool failure",
      operation: "read-superproject-origin",
      matches: (argv: readonly string[]) => argv.at(-1) === "remote.origin.url",
      exitCode: 128,
      signal: null,
      stderr: "",
      timedOut: false,
    },
  ] as const)(
    "keeps the candidate submitted after a $name",
    async (failure) => {
      const fixture = await hookedSubmoduleRepository({
        baseVersion: "base",
        candidateVersion: "candidate",
        requiredVersion: "candidate",
      })
      await using process = createProcess()
      let configuredCheckRan = false
      let injectedFailure = false
      const unavailable: Pick<Process, "run"> = {
        run(request) {
          if (request.argv[0] === "true") configuredCheckRan = true
          const shouldInject = failure.matches(request.argv) && (failure.operation !== "verify" || !injectedFailure)
          if (shouldInject) {
            injectedFailure = true
            const base = {
              exitCode: failure.exitCode,
              signal: failure.signal,
              stdout: "",
              stderr: failure.stderr,
              durationMs: 1,
            }
            return Promise.resolve(
              failure.timedOut
                ? ({ ...base, timedOut: true } satisfies ProcessResult)
                : ({ ...base, timedOut: false } satisfies ProcessResult),
            )
          }
          return process.run(request)
        },
      }
      await using app = await checkedQueue(unavailable, fixture.repo, ["true"])
      await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      expect(run).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "queue-environment-refused",
          evidence: {
            kind: "submodule-reachability-refusal",
            operation: failure.operation,
            exitCode: failure.exitCode,
            timedOut: failure.timedOut,
            signal: failure.signal,
            retryable: true,
          },
        },
      })
      expect(configuredCheckRan).toBe(false)
      expect(injectedFailure).toBe(true)
      expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
        status: "submitted",
        headSha: fixture.featureSha,
      })
    },
    15_000,
  )

  it("allows an absolute submodule URL after an exact no-value origin lookup", async () => {
    const fixture = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    const noOrigin: Pick<Process, "run"> = {
      run(request) {
        if (request.argv.at(-1) === "remote.origin.url") {
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(noOrigin, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status).toBe("completed")
  }, 15_000)

  it("keeps a relative submodule URL submitted when the origin lookup has no value", async () => {
    const fixture = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await using process = createProcess()
    let configuredCheckRan = false
    const noOrigin: Pick<Process, "run"> = {
      async run(request) {
        if (request.argv[0] === "true") configuredCheckRan = true
        if (request.argv.includes("--blob")) {
          const result = await process.run(request)
          return {
            ...result,
            // oxlint-disable-next-line no-control-regex -- `git config --null` records are NUL-delimited by contract.
            stdout: result.stdout.replace(/(submodule\.[^\u0000\n]+\.url\n)[^\u0000]*/u, "$1../dep.git"),
          }
        }
        if (request.argv.at(-1) === "remote.origin.url") {
          return {
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          }
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(noOrigin, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: {
          kind: "submodule-reachability-refusal",
          operation: "read-superproject-origin",
          exitCode: 1,
          retryable: true,
        },
      },
    })
    expect(configuredCheckRan).toBe(false)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "submitted",
      headSha: fixture.featureSha,
    })
  }, 15_000)

  it.each(["seeded", "unseeded"] as const)(
    "refuses an unreachable exact pin from a fresh store with an operator tree that is %s",
    async (operator) => {
      const fixture = await hookedSubmoduleRepository({
        baseVersion: "base",
        candidateVersion: "candidate",
        requiredVersion: "candidate",
      })
      let repo = fixture.repo
      if (operator === "unseeded") {
        repo = join(fixture.repo, "..", "unseeded-super")
        await Bun.$`git clone -q --branch main ${fixture.remote} ${repo}`
        await git(repo, ["fetch", "-q", "origin", "issue/feature"])
      }
      expect(existsSync(join(repo, ".git", "modules", "dep"))).toBe(operator === "seeded")

      await using process = createProcess()
      const requests: ProcessRequest[] = []
      let configuredCheckRan = false
      const unreachable: Pick<Process, "run"> = {
        run(request) {
          requests.push(request)
          if (request.argv[0] === "true") configuredCheckRan = true
          if (request.argv.includes("--filter=tree:0")) {
            return Promise.resolve({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: `remote error: upload-pack: not our ref ${fixture.moduleSha}`,
              durationMs: 1,
              timedOut: false,
            })
          }
          return process.run(request)
        },
      }
      await using app = await checkedQueue(unreachable, repo, ["true"])
      await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: fixture.featureSha })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      expect(run).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: expect.stringContaining("not our ref") },
      })
      const proofFetches = requests.filter(({ argv }) => argv.includes("--depth=1"))
      expect(proofFetches).toHaveLength(1)
      expect(proofFetches[0]?.argv).toContain("--filter=tree:0")
      expect(configuredCheckRan).toBe(false)
      expect(requests.some(({ argv }) => argv.includes("submodule") && argv.includes("update"))).toBe(false)
      expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
        status: "submitted",
        headSha: fixture.featureSha,
      })
    },
    15_000,
  )

  it("fails loudly when a composed candidate gitlink has no URL", async () => {
    const fixture = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await git(fixture.repo, ["switch", "-q", "issue/feature"])
    await git(fixture.repo, ["config", "-f", ".gitmodules", "--unset-all", "submodule.dep.url"])
    await git(fixture.repo, ["add", ".gitmodules"])
    await git(fixture.repo, ["commit", "-qm", "remove candidate submodule URL"])
    const featureSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    await using process = createProcess()
    let configuredCheckRan = false
    const traced: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "true") configuredCheckRan = true
        return process.run(request)
      },
    }
    await using app = await checkedQueue(traced, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-failed", message: expect.stringContaining("has no URL") },
    })
    expect(configuredCheckRan).toBe(false)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })


  it("runs remote push hooks without inheriting recursive submodule pushes", async () => {
    const { repo, remote, featureSha, moduleSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })
    await git(repo, ["config", "push.recurseSubmodules", "on-demand"])

    await using process = createProcess()
    const pushes: (readonly string[])[] = []
    const recordingProcess: Pick<Process, "run"> = {
      async run(request) {
        if (request.argv[0] === "git" && request.argv[3] === "push") pushes.push(request.argv)
        return process.run(request)
      },
    }
    await using app = await checkedQueue(
      recordingProcess,
      repo,
      // Local paths exist only in this synthetic fixture; allow them explicitly
      // so the check reaches the remote-push behavior this test specifies.
      shellCommand(
        'git -c protocol.file.allow=always submodule update --init --recursive && test "$(cat dep/version.txt)" = candidate',
      ),
    )
    await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run, JSON.stringify(run, null, 2)).toMatchObject({
      status: "completed",
      conclusion: "success",
      prs: [{ headSha: featureSha }],
    })
    const proof = IntegrationProofSchema.parse(run.integration)
    const rootPush = pushes.find((argv) => argv.includes(`${proof.commit}:refs/heads/main`))
    expect(rootPush).toContain("--recurse-submodules=no")
    const recordPush = pushes.find((argv) =>
      argv.some((argument) => argument.endsWith(":refs/notes/yrd/merge-records")),
    )
    expect(recordPush).toEqual(expect.arrayContaining(["--no-verify", "--recurse-submodules=no"]))
    expect(await git(remote, ["ls-tree", "main", "dep"])).toContain(moduleSha)
  })

  it("keeps the submit-time publication carrier after an ordinary task-branch fast-forward", async () => {
    const fixture = await submoduleMainMergeRepository({ pushSuccessor: true })
    const carriers = await git(join(fixture.repo, "dep"), [
      "for-each-ref",
      `--contains=${fixture.pinSha}`,
      "--format=%(refname)",
      "refs/remotes/origin/",
    ])

    expect(carriers).toContain("refs/remotes/origin/task/submodule")
    expect(
      await git(fixture.submoduleRemote, ["merge-base", "--is-ancestor", fixture.pinSha, fixture.successorSha]),
    ).toBe("")
  })

  it.each(["native", "configured"] as const)(
    "advances submodule main when a root gitlink merges (%s)",
    async (mode) => {
      // The task branch advances again after publishing the pin, matching the
      // production sequence that made the post-merge actuator necessary.
      const fixture = await submoduleMainMergeRepository({ pushSuccessor: true })
      expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.submoduleBaseSha)

      await using process = createProcess()
      await using app = await checkedQueue(
        process,
        fixture.repo,
        ["true"],
        mode === "configured"
          ? { mergeCommand: shellCommand('git push origin "$YRD_CANDIDATE_SHA":refs/heads/main') }
          : {},
      )
      await submitCertifiedCarrier(app, fixture.repo, {
        branch: "issue/feature",
        headSha: fixture.featureSha,
        baseSha: fixture.rootBaseSha,
      })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      expect(run).toMatchObject({ status: "completed", conclusion: "success" })
      expect((run.integration as unknown as { componentMains?: unknown }).componentMains).toEqual([
        {
          action: "fast-forwarded",
          mainAfterSha: fixture.pinSha,
          mainBeforeSha: fixture.submoduleBaseSha,
          origin: fixture.submoduleRemote,
          path: "dep",
          pinSha: fixture.pinSha,
        },
      ])
      expect(await git(fixture.rootRemote, ["ls-tree", "main", "dep"])).toContain(fixture.pinSha)
      expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.pinSha)
      if (mode === "native") {
        const merged = IntegrationProofSchema.parse(run.integration).commit
        await git(fixture.repo, ["branch", "query-base", merged])
        await git(fixture.repo, ["switch", "-q", "query-base"])
        await git(join(fixture.repo, "dep"), ["checkout", "-q", fixture.successorSha])
        await git(fixture.repo, ["add", "dep"])
        await git(fixture.repo, ["commit", "-qm", "advance contained submodule pin"])
        const currentBase = await git(fixture.repo, ["rev-parse", "HEAD"])

        await expect(
          findRepositoryMergeRecords({
            inject: { process },
            repo: fixture.repo,
            baseSha: currentBase,
            selector: "PR1",
          }),
        ).resolves.toMatchObject({
          status: "proven",
          records: [
            {
              record: {
                merge: { id: run.id, result: "merged", mergedCommit: merged },
                pins: [{ path: "dep", before: fixture.submoduleBaseSha, after: fixture.pinSha }],
              },
            },
          ],
        })
      }
    },
    20_000,
  )

  it("refuses a success-looking no-op actuator instead of emitting an empty submodule outcome set", async () => {
    const fixture = await submoduleMainMergeRepository()
    await using process = createProcess()
    const noOpProcess: Pick<Process, "run"> = {
      run(request) {
        if (
          request.argv[0] === "git" &&
          request.argv.includes("push") &&
          request.argv.includes(fixture.submoduleRemote)
        ) {
          return Promise.resolve({
            exitCode: 0,
            signal: null,
            stdout: "Done",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(noOpProcess, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "component-main-promotion-failed",
        evidence: {
          kind: "component-main-outcomes",
          results: [],
          refusals: [
            {
              code: "component-main-promotion-failed",
              path: "dep",
              pinSha: fixture.pinSha,
            },
          ],
        },
      },
    })
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.submoduleBaseSha)
  }, 20_000)

  it("fast-forwards a clean checked-out main at a local non-bare submodule origin", async () => {
    const fixture = await submoduleMainMergeRepository({ nonBareComponentOrigin: true })
    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    expect((run.integration as unknown as { componentMains?: unknown }).componentMains).toEqual([
      expect.objectContaining({ action: "fast-forwarded", path: "dep", pinSha: fixture.pinSha }),
    ])
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.pinSha)
    expect(await readFile(join(fixture.submodule, "version.txt"), "utf8")).toBe("pin\n")
  }, 20_000)

  it("refuses to advance a dirty checked-out main at a local non-bare submodule origin", async () => {
    const fixture = await submoduleMainMergeRepository({ nonBareComponentOrigin: true })
    await writeFile(join(fixture.submodule, "version.txt"), "dirty\n")
    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "component-main-promotion-failed",
        evidence: {
          kind: "component-main-outcomes",
          results: [],
          refusals: [
            expect.objectContaining({
              code: "component-main-promotion-failed",
              path: "dep",
              pinSha: fixture.pinSha,
            }),
          ],
        },
      },
    })
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.submoduleBaseSha)
    expect(await readFile(join(fixture.submodule, "version.txt"), "utf8")).toBe("dirty\n")
  }, 20_000)

  it.each(["native", "configured"] as const)(
    "converges a submodule-main gap left by an earlier root-only merging while merging a later PR (%s)",
    async (mode) => {
      const fixture = await submoduleMainMergeRepository()

      // Preserve the production R2715 residue: the root pin merged, but its
      // submodule main never advanced. The next carrier does not touch the
      // gitlink, so changed-pin-only planning cannot see the standing gap.
      await git(fixture.repo, ["push", "-q", "origin", `${fixture.featureSha}:refs/heads/main`])
      expect(await git(fixture.rootRemote, ["ls-tree", "main", "dep"])).toContain(fixture.pinSha)
      expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.submoduleBaseSha)

      await git(fixture.repo, ["switch", "-q", "issue/feature"])
      await git(fixture.repo, ["branch", "-f", "main", fixture.featureSha])
      await git(fixture.repo, ["switch", "-qc", "issue/followup", fixture.featureSha])
      await writeFile(join(fixture.repo, "followup.txt"), "followup\n")
      await git(fixture.repo, ["add", "followup.txt"])
      await git(fixture.repo, ["commit", "-qm", "followup"])
      const followupSha = await git(fixture.repo, ["rev-parse", "HEAD"])
      await git(fixture.repo, ["push", "-q", "origin", "issue/followup"])

      await using process = createProcess()
      await using app = await checkedQueue(
        process,
        fixture.repo,
        ["true"],
        mode === "configured"
          ? { mergeCommand: shellCommand('git push origin "$YRD_CANDIDATE_SHA":refs/heads/main') }
          : {},
      )
      await app.bays.submit({ branch: "issue/followup", headSha: followupSha, base: "main" })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      expect(run).toMatchObject({ status: "completed", conclusion: "success" })
      expect(await git(fixture.rootRemote, ["merge-base", "--is-ancestor", followupSha, "main"])).toBe("")
      expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.pinSha)
    },
    20_000,
  )

  it.each(["native", "configured"] as const)(
    "advances safe submodule mains while loudly refusing an independent standing divergence (%s)",
    async (mode) => {
      const fixture = await multiSubmoduleMainMergeRepository()
      const [divergentSubmodule, safeSubmodule] = fixture.submodules
      if (divergentSubmodule === undefined || safeSubmodule === undefined) {
        throw new Error("missing multi-submodule fixture")
      }

      const divergentWorktree = join(fixture.repo, "..", "divergent-component-main")
      await git(join(fixture.repo, ".."), ["clone", "-q", divergentSubmodule.remote, divergentWorktree])
      await git(divergentWorktree, ["config", "user.name", "Yrd Test"])
      await git(divergentWorktree, ["config", "user.email", "yrd@example.invalid"])
      await writeFile(join(divergentWorktree, "divergent.txt"), "divergent\n")
      await git(divergentWorktree, ["add", "divergent.txt"])
      await git(divergentWorktree, ["commit", "-qm", "divergent main"])
      const divergentMainSha = await git(divergentWorktree, ["rev-parse", "HEAD"])
      await git(divergentWorktree, ["push", "-q", "origin", "main"])

      // Preserve a root-only merge with two standing submodule gaps. The
      // first origin now needs a compose; the second remains a plain FF.
      await git(fixture.repo, ["push", "-q", "origin", `${fixture.featureSha}:refs/heads/main`])
      await git(fixture.repo, ["switch", "-q", "issue/feature"])
      await git(fixture.repo, ["branch", "-f", "main", fixture.featureSha])
      await git(fixture.repo, ["switch", "-qc", "issue/followup", fixture.featureSha])
      await writeFile(join(fixture.repo, "followup.txt"), "followup\n")
      await git(fixture.repo, ["add", "followup.txt"])
      await git(fixture.repo, ["commit", "-qm", "followup"])
      const followupSha = await git(fixture.repo, ["rev-parse", "HEAD"])
      await git(fixture.repo, ["push", "-q", "origin", "issue/followup"])

      await using process = createProcess()
      await using app = await checkedQueue(
        process,
        fixture.repo,
        ["true"],
        mode === "configured"
          ? { mergeCommand: shellCommand('git push origin "$YRD_CANDIDATE_SHA":refs/heads/main') }
          : {},
      )
      await app.bays.submit({ branch: "issue/followup", headSha: followupSha, base: "main" })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      // The contains-base guard names the dropped standing-main commit, which
      // supersedes the older generic non-ancestral classification.
      expect(run, JSON.stringify(run, null, 2)).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: { code: "carrier-drops-landed" },
      })
      expect(run.error?.evidence).toMatchObject({
        kind: "component-main-outcomes",
        results: [
          {
            action: "fast-forwarded",
            path: safeSubmodule.path,
            pinSha: safeSubmodule.pinSha,
          },
        ],
        refusals: [
          {
            code: "carrier-drops-landed",
            path: divergentSubmodule.path,
            pinSha: divergentSubmodule.pinSha,
          },
        ],
      })
      expect(await git(fixture.rootRemote, ["merge-base", "--is-ancestor", followupSha, "main"])).toBe("")
      expect(await git(divergentSubmodule.remote, ["rev-parse", "main"])).toBe(divergentMainSha)
      expect(await git(safeSubmodule.remote, ["rev-parse", "main"])).toBe(safeSubmodule.pinSha)
    },
    40_000,
  )

  it("classifies against freshly fetched submodule main instead of a stale bay tracking ref", async () => {
    const fixture = await submoduleMainMergeRepository()
    const baySubmodule = join(fixture.repo, "dep")
    expect(await git(baySubmodule, ["rev-parse", "origin/main"])).toBe(fixture.submoduleBaseSha)
    await git(fixture.submodule, ["push", "-q", "origin", `${fixture.pinSha}:refs/heads/main`])
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.pinSha)
    expect(await git(baySubmodule, ["rev-parse", "origin/main"])).toBe(fixture.submoduleBaseSha)

    await using process = createProcess()
    const submodulePushes: ProcessRequest[] = []
    const recordingProcess: Pick<Process, "run"> = {
      run(request) {
        if (
          request.argv[0] === "git" &&
          request.argv.includes("push") &&
          request.argv.includes(fixture.submoduleRemote)
        ) {
          submodulePushes.push(request)
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(recordingProcess, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    expect(submodulePushes).toEqual([])
    expect((run.integration as unknown as { componentMains?: unknown }).componentMains).toEqual([
      {
        action: "verified",
        mainAfterSha: fixture.pinSha,
        mainBeforeSha: fixture.pinSha,
        origin: fixture.submoduleRemote,
        path: "dep",
        pinSha: fixture.pinSha,
      },
    ])
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.pinSha)
  }, 20_000)

  it("refuses a non-ancestral submodule main without merging or force-pushing", async () => {
    const fixture = await submoduleMainMergeRepository()
    await git(fixture.submodule, ["switch", "-q", "main"])
    await writeFile(join(fixture.submodule, "divergent.txt"), "divergent main\n")
    await git(fixture.submodule, ["add", "divergent.txt"])
    await git(fixture.submodule, ["commit", "-qm", "divergent main"])
    const divergentMainSha = await git(fixture.submodule, ["rev-parse", "HEAD"])
    await git(fixture.submodule, ["push", "-q", "origin", "main"])

    await using process = createProcess()
    const pushes: string[][] = []
    const recordingProcess: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("push")) pushes.push([...request.argv])
        return process.run(request)
      },
    }
    await using app = await checkedQueue(recordingProcess, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, { branch: "issue/feature", headSha: fixture.featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "carrier-drops-landed",
        message: expect.stringMatching(/divergent main.*merge submodule target.*push and resubmit/isu),
        evidence: {
          kind: "component-main-outcomes",
          results: [],
          refusals: [
            {
              code: "carrier-drops-landed",
              origin: fixture.submoduleRemote,
              path: "dep",
              pinSha: fixture.pinSha,
            },
          ],
        },
      },
    })
    expect(await git(fixture.rootRemote, ["rev-parse", "main"])).toBe(fixture.rootBaseSha)
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(divergentMainSha)
    expect(pushes.flat()).not.toContain("--force")
  }, 20_000)

  /**
   * The sibling below covers a DIVERGENT submodule pin: the carrier resolved
   * against an older main, so pin and submodule main share no ancestry line and
   * the work genuinely still needs re-deriving. This covers the other half —
   * a SPENT pin, a strict ancestor of submodule main.
   *
   * The two are the same ancestry test and opposite cures. A spent pin has
   * nothing left to deliver, so "linear rebuild required" is advice that cannot
   * succeed: the author rebuilds, the rebuild is empty, and the carrier is
   * refused again on the same ground. That is the loop PR562 rode to revision 43.
   *
   * The guard here is the promotion loop's covered-skip (command.ts:4345):
   * `pin ⊆ targetSha` continues past the pin entirely, so `inspectBaseContainment`
   * at :4381 is never reached for a spent pin and its head-in-base direction is
   * unreachable on this path. The same skip is why the promotion target is
   * monotonic — it only ever advances, at :4361 — so a spent pin cannot write
   * anything backward.
   */
  /**
   * The rollback edge the backward-pin lore actually guards: a carrier whose HEAD
   * is clean — it contains the current base, so nothing about it looks stale —
   * but whose TREE moves the gitlink to an OLDER submodule sha. Nothing in the
   * promotion loop sees this, because that loop reads merged min-commit changes rather
   * than a branch carrier's authored tree, so if this merged it would silently
   * revert the submodule.
   *
   * It is NOT refused — it merges. The guard is monotonicity, not refusal: the
   * promotion target only ever advances (command.ts:4361), so the merge writes
   * the forward pin and the authored backward gitlink loses to it. That is
   * invisible from either end on its own — read admission and the carrier looks
   * unguarded, read the promotion loop and it looks unreachable — so the
   * assertion below reads the pin the run actually wrote.
   */
  it("does not roll the submodule back for a clean-headed carrier that moves the gitlink backward", async () => {
    const fixture = await submoduleMainMergeRepository()

    // Submodule main absorbs the pinned work, and the root advances its gitlink
    // to match, so the carrier below branches from a base that is fully current.
    await git(fixture.submodule, ["switch", "-q", "main"])
    await git(fixture.submodule, ["merge", "-q", "--ff-only", fixture.pinSha])
    await git(fixture.submodule, ["push", "-q", "origin", "main"])
    await git(fixture.repo, ["switch", "-q", "main"])
    await git(join(fixture.repo, "dep"), ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await git(join(fixture.repo, "dep"), ["checkout", "-q", fixture.pinSha])
    await git(fixture.repo, ["add", "dep"])
    await git(fixture.repo, ["commit", "-qm", "advance dependency to submodule main"])
    const currentBase = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["push", "-q", "origin", "main"])

    // The carrier branches from that current base — its head is clean — and
    // walks the gitlink back to the submodule's earlier commit.
    await git(fixture.repo, ["switch", "-qc", "issue/backward-gitlink", currentBase])
    await git(join(fixture.repo, "dep"), ["checkout", "-q", fixture.submoduleBaseSha])
    await git(fixture.repo, ["add", "dep"])
    await git(fixture.repo, ["commit", "-qm", "walk the dependency back"])
    const carrierHead = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["push", "-q", "origin", "issue/backward-gitlink"])
    await git(fixture.repo, ["switch", "-q", "main"])

    // Clean head: the carrier contains the current base. `git()` throws on a
    // non-zero exit, so this call is the precondition.
    await git(fixture.repo, ["merge-base", "--is-ancestor", currentBase, carrierHead])

    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, {
      branch: "issue/backward-gitlink",
      headSha: carrierHead,
      baseSha: currentBase,
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    // The property under test is not "it refused" but "it did not roll the
    // submodule back", so read the pin the run actually wrote.
    await git(fixture.repo, ["switch", "-q", "main"])
    const writtenPin = (await git(fixture.repo, ["ls-tree", "HEAD", "dep"])).split(/\s+/u)[2] ?? "none"
    const walkedBack =
      writtenPin !== "none" &&
      writtenPin !== fixture.pinSha &&
      (await git(fixture.submodule, ["merge-base", "--is-ancestor", writtenPin, fixture.pinSha])
        .then(() => true)
        .catch(() => false))

    // It MERGES — the carrier is admitted, which is the surprising half. What
    // protects the submodule is that the merge writes the forward pin anyway:
    // the promotion target only ever advances (:4361), so the authored backward
    // gitlink loses to it. Refusal is not the guard here; monotonicity is.
    expect({ conclusion: run?.conclusion, writtenPin, walkedBack }).toEqual({
      conclusion: "success",
      writtenPin: fixture.pinSha,
      walkedBack: false,
    })
  })

  it("does not tell a spent submodule pin to rebuild when submodule main already contains it", async () => {
    const fixture = await submoduleMainMergeRepository()

    // The submodule merges the pinned work and moves on.
    await git(fixture.submodule, ["switch", "-q", "main"])
    await git(fixture.submodule, ["merge", "-q", "--no-ff", fixture.pinSha, "-m", "merge the pinned submodule work"])
    await writeFile(join(fixture.submodule, "later.txt"), "later\n")
    await git(fixture.submodule, ["add", "later.txt"])
    await git(fixture.submodule, ["commit", "-qm", "later submodule merge"])
    const submoduleMain = await git(fixture.submodule, ["rev-parse", "HEAD"])
    await git(fixture.submodule, ["push", "-q", "origin", "main"])

    // `git()` throws on a non-zero exit, so the ancestry call is itself the
    // precondition: the pin is contained, and submodule main has moved past it,
    // which is what separates spent from a no-op.
    await git(fixture.submodule, ["merge-base", "--is-ancestor", fixture.pinSha, submoduleMain])
    expect(await git(fixture.submodule, ["log", "--oneline", `${fixture.pinSha}..${submoduleMain}`])).not.toBe("")

    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, {
      branch: "issue/feature",
      headSha: fixture.featureSha,
      baseSha: fixture.rootBaseSha,
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]

    expect(run).not.toMatchObject({ error: { code: "carrier-drops-landed" } })
  })


  it("refuses a stale resolved submodule pin and enumerates the submodule commits it would drop", async () => {
    const fixture = await submoduleMainMergeRepository()
    await git(fixture.submodule, ["switch", "-q", "main"])
    await writeFile(join(fixture.submodule, "earlier-merge.txt"), "already resolved\n")
    await git(fixture.submodule, ["add", "earlier-merge.txt"])
    await git(fixture.submodule, ["commit", "-qm", "submodule merge already resolved"])
    await git(fixture.submodule, ["switch", "-q", "task/submodule"])
    await git(fixture.submodule, ["merge", "-q", "--no-ff", "main", "-m", "resolve submodule carrier"])
    const resolvedPin = await git(fixture.submodule, ["rev-parse", "HEAD"])
    await git(fixture.submodule, ["push", "-q", "origin", "task/submodule"])

    await git(fixture.repo, ["switch", "-qc", "issue/stale-component", fixture.rootBaseSha])
    await git(join(fixture.repo, "dep"), ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await git(join(fixture.repo, "dep"), ["checkout", "-q", resolvedPin])
    await git(fixture.repo, ["add", "dep"])
    await git(fixture.repo, ["commit", "-qm", "pin resolved submodule carrier"])
    const carrierHead = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["push", "-q", "origin", "issue/stale-component"])
    await git(fixture.repo, ["switch", "-q", "main"])
    await git(fixture.repo, ["-c", "protocol.file.allow=always", "submodule", "update", "-q"])

    await git(fixture.submodule, ["switch", "-q", "main"])
    await writeFile(join(fixture.submodule, "protected-component-merge.txt"), "must survive\n")
    await git(fixture.submodule, ["add", "protected-component-merge.txt"])
    await git(fixture.submodule, ["commit", "-qm", "protected submodule merge after resolution"])
    const submoduleMain = await git(fixture.submodule, ["rev-parse", "HEAD"])
    await git(fixture.submodule, ["push", "-q", "origin", "main"])
    expect(await git(fixture.submodule, ["merge-tree", "--write-tree", submoduleMain, resolvedPin])).toMatch(
      /^[0-9a-f]{40}$/u,
    )

    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, {
      branch: "issue/stale-component",
      headSha: carrierHead,
      baseSha: fixture.rootBaseSha,
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "carrier-drops-landed",
        message: expect.stringMatching(/protected submodule merge after resolution.*merge submodule target.*push and resubmit/isu),
      },
    })
    expect(await git(fixture.rootRemote, ["rev-parse", "main"])).toBe(fixture.rootBaseSha)
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(submoduleMain)
  }, 20_000)

  it("leaves the root merged and converges submodule main when a transient promotion failure is retried", async () => {
    const fixture = await submoduleMainMergeRepository()
    await using process = createProcess()
    let failedPromotion = false
    const flakyProcess: Pick<Process, "run"> = {
      run(request) {
        if (
          !failedPromotion &&
          request.argv[0] === "git" &&
          request.argv.includes("push") &&
          request.argv.includes(fixture.submoduleRemote)
        ) {
          failedPromotion = true
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "transient submodule push failure",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(flakyProcess, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, {
      branch: "issue/feature",
      headSha: fixture.featureSha,
      baseSha: fixture.rootBaseSha,
    })

    const first = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(failedPromotion).toBe(true)
    expect(first).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "component-main-promotion-failed",
        evidence: {
          kind: "component-main-outcomes",
          results: [],
          refusals: [
            {
              code: "component-main-promotion-failed",
              path: "dep",
              pinSha: fixture.pinSha,
            },
          ],
        },
      },
    })
    expect(await git(fixture.rootRemote, ["ls-tree", "main", "dep"])).toContain(fixture.pinSha)
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.submoduleBaseSha)

    const retried = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(retried, JSON.stringify(retried, null, 2)).toMatchObject({ status: "completed", conclusion: "success" })
    expect((retried.integration as unknown as { componentMains?: unknown }).componentMains).toEqual([
      {
        action: "fast-forwarded",
        mainAfterSha: fixture.pinSha,
        mainBeforeSha: fixture.submoduleBaseSha,
        origin: fixture.submoduleRemote,
        path: "dep",
        pinSha: fixture.pinSha,
      },
    ])
    expect(await git(fixture.submoduleRemote, ["rev-parse", "main"])).toBe(fixture.pinSha)
  }, 30_000)

  it("keeps earlier submodule fast-forwards and converges the remaining origins on retry", async () => {
    const fixture = await multiSubmoduleMainMergeRepository()
    const [firstSubmodule, secondSubmodule] = fixture.submodules
    if (firstSubmodule === undefined || secondSubmodule === undefined) {
      throw new Error("missing multi-submodule fixture")
    }
    await using process = createProcess()
    let failedSecondPromotion = false
    const submodulePushes: string[][] = []
    const flakyProcess: Pick<Process, "run"> = {
      run(request) {
        if (
          request.argv[0] === "git" &&
          request.argv.includes("push") &&
          fixture.submodules.some((submodule) => request.argv.includes(submodule.remote))
        ) {
          submodulePushes.push([...request.argv])
        }
        if (
          !failedSecondPromotion &&
          request.argv[0] === "git" &&
          request.argv.includes("push") &&
          request.argv.includes(secondSubmodule.remote)
        ) {
          failedSecondPromotion = true
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "transient second submodule push failure",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(flakyProcess, fixture.repo, ["true"])
    await submitCertifiedCarrier(app, fixture.repo, {
      branch: "issue/feature",
      headSha: fixture.featureSha,
      baseSha: fixture.rootBaseSha,
    })

    const first = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(failedSecondPromotion).toBe(true)
    expect(first).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "component-main-promotion-failed",
        evidence: {
          kind: "component-main-outcomes",
          results: [
            {
              action: "fast-forwarded",
              path: firstSubmodule.path,
              pinSha: firstSubmodule.pinSha,
            },
          ],
          refusals: [
            {
              code: "component-main-promotion-failed",
              path: secondSubmodule.path,
              pinSha: secondSubmodule.pinSha,
            },
          ],
        },
      },
    })
    expect(await git(fixture.rootRemote, ["rev-parse", "main"])).not.toBe(fixture.rootBaseSha)
    expect(await git(firstSubmodule.remote, ["rev-parse", "main"])).toBe(firstSubmodule.pinSha)
    expect(await git(secondSubmodule.remote, ["rev-parse", "main"])).toBe(secondSubmodule.baseSha)
    expect(submodulePushes.filter((argv) => argv.includes(firstSubmodule.remote))).toHaveLength(1)
    expect(submodulePushes.filter((argv) => argv.includes(secondSubmodule.remote))).toHaveLength(1)

    const retried = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(retried, JSON.stringify(retried, null, 2)).toMatchObject({ status: "completed", conclusion: "success" })
    expect((retried.integration as unknown as { componentMains?: unknown }).componentMains).toEqual([
      expect.objectContaining({
        action: "verified",
        path: firstSubmodule.path,
        pinSha: firstSubmodule.pinSha,
      }),
      expect.objectContaining({
        action: "fast-forwarded",
        path: secondSubmodule.path,
        pinSha: secondSubmodule.pinSha,
      }),
    ])
    expect(await git(firstSubmodule.remote, ["rev-parse", "main"])).toBe(firstSubmodule.pinSha)
    expect(await git(secondSubmodule.remote, ["rev-parse", "main"])).toBe(secondSubmodule.pinSha)
    expect(submodulePushes.filter((argv) => argv.includes(firstSubmodule.remote))).toHaveLength(1)
    expect(submodulePushes.filter((argv) => argv.includes(secondSubmodule.remote))).toHaveLength(2)
  }, 40_000)

  it("rejects a checked candidate that fails a hook even when the operator tree passes it", async () => {
    const { repo, remote, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "accepted",
      candidateVersion: "invalid",
      requiredVersion: "accepted",
    })
    await using process = createProcess()
    // Local paths exist only in this synthetic fixture; allow them explicitly
    // so the candidate reaches the hook failure this test specifies.
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand("git -c protocol.file.allow=always submodule update --init --recursive"),
    )
    await submitCertifiedCarrier(app, repo, { branch: "issue/feature", headSha: featureSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run, JSON.stringify(run, null, 2)).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "merge-push-failed" },
    })
    expect(await git(remote, ["rev-parse", "main"])).toBe(baseSha)
  })

  it("keeps one same-base run active before the remote compare-and-push", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/one", "issue/two"])
    const localMain = await git(repo, ["rev-parse", "main"])

    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/one", headSha: firstSha, base: "main" })
    await app.bays.submit({ branch: "issue/two", headSha: secondSha, base: "main" })

    const settled = await Promise.allSettled([
      app.queue.run({ prs: ["PR1"] }, { runner: "worker-1", leaseMs: 60_000 }),
      app.queue.run({ prs: ["PR2"] }, { runner: "worker-2", leaseMs: 60_000 }),
    ])
    const completed = settled.find((result) => result.status === "fulfilled")
    const refused = settled.find((result) => result.status === "rejected")

    expect(completed).toMatchObject({
      status: "fulfilled",
      value: [expect.objectContaining({ status: "completed", conclusion: "success" })],
    })
    expect(refused).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("queue 'main' is running") }),
    })
    const merge = await git(remote, ["rev-parse", "main"])
    const mergedPaths = (await git(remote, ["ls-tree", "--name-only", merge])).split("\n")
    expect(mergedPaths.filter((path) => path === "one.txt" || path === "two.txt")).toHaveLength(1)
    expect(await git(repo, ["rev-parse", "main"])).toBe(localMain)
  })

  it("refuses an intervening remote move instead of retrying the stale Candidate", async () => {
    const { repo, feature: featureSha, competing: competingSha } = await repository("feature", "competing")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature", "issue/competing"])

    await using process = createProcess()
    let raced = false
    const racingProcess: Pick<Process, "run"> = {
      async run(request) {
        if (!raced && request.argv.includes("push")) {
          raced = true
          await git(repo, ["push", "-q", "origin", `${competingSha}:refs/heads/main`])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(racingProcess, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(raced).toBe(true)
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-base" } })
    expect(await git(remote, ["rev-parse", "main"])).toBe(competingSha)
    expect(await git(repo, ["rev-parse", checked.candidateRef])).toBe(checked.candidateSha)
  })

  it("preserves remote evidence and merges its pinned candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        `printf '%s\\n' '{"token":"ci-1","url":"https://ci.invalid/1","detail":"queued",` +
          `"artifacts":[{"name":"remote","uri":"artifact://ci-1"}]}'`,
      ),
      { waiting: true },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const waiting = run.steps[0]?.job
    if (waiting?.status !== "waiting") throw new Error("check did not wait")
    const checkpoint = GitCheckEvidenceSchema.parse(waiting.checkpoint)
    expect(waiting).toMatchObject({ token: "ci-1", url: "https://ci.invalid/1", detail: "queued" })
    expect(waiting.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "artifact://ci-1" })]))
    expect(await git(repo, ["rev-parse", checkpoint.candidateRef])).toBe(checkpoint.candidateSha)

    const finished = await app.queue.finish(
      run.id,
      {
        job: waiting.id,
        attempt: waiting.attempt,
        runner: waiting.runner,
        token: waiting.token,
        result: { status: "completed", conclusion: "success", output: checkpoint },
      },
      runtime,
    )
    expect(finished.status).toBe("completed")
    await expectMerged(repo, checkpoint)
  })

  it("refuses merge when the base moves after the checked candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
      {
        revision: "check-v1",
        output: GitCheckResultEvidenceSchema,
      },
    )
    const MovedSchema = z.object({ moved: z.literal(true) }).strict()
    type Moved = AddStepResult<Checked, "move-base", z.infer<typeof MovedSchema>>
    const move = withStep(
      "move-base",
      async (_input: StepExecution<Checked>) => {
        await writeFile(join(repo, "base-moved.txt"), "moved after check\n")
        await git(repo, ["add", "base-moved.txt"])
        await git(repo, ["commit", "-qm", "move base after check"])
        return { status: "completed", conclusion: "success" as const, output: { moved: true as const } }
      },
      { revision: "move-base-v1", output: MovedSchema },
    )
    const merge = withMerge(gitMergeStep<Moved>({ inject: { process }, repo }), { revision: "git-merge-v1" })
    const queue = withQueue({
      steps: [check, move, merge] as const,
      resolveBaseSha: (base) => queueBaseSha(repo, base),
    })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), {
      inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(existsSync(join(repo, "feature.txt"))).toBe(false)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
  })

  it.each(["native-worktree", "native-ref", "native-remote", "configured"] as const)(
    "drains canceled or superseded authority at the %s merge side-effect boundary",
    async (mergeMode) => {
      const { repo, feature: featureSha } = await repository("feature")
      const baseSha = await git(repo, ["rev-parse", "main"])
      await using process = createProcess()
      const checkInput = {
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      } satisfies StepExecution<ChangeShape>
      const checked = await gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] })(
        checkInput,
        { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal },
      )
      if (checked.status !== "completed" || checked.conclusion !== "success") throw new Error("check did not pass")
      if (mergeMode === "native-remote") {
        const remote = join(repo, "..", "origin.git")
        await Bun.$`git init -q --bare ${remote}`
        await git(repo, ["remote", "add", "origin", remote])
        await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
      } else if (mergeMode === "native-ref") {
        await git(repo, ["switch", "--detach", "-q", baseSha])
      }

      const canceled = new AbortController()
      let mergeRuns = 0
      const authorityProcess: Pick<Process, "run"> = {
        async run(request) {
          if (request.argv[0] === "merge-must-not-run") {
            mergeRuns += 1
            return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }
          }
          if (
            request.argv[0] === "git" &&
            ((mergeMode === "native-remote" &&
              request.argv[3] === "config" &&
              request.argv.includes("submodule.alternateLocation")) ||
              (mergeMode !== "native-remote" &&
                request.argv[3] === "merge-base" &&
                request.argv[4] === "--is-ancestor" &&
                request.argv[5] === featureSha))
          ) {
            canceled.abort()
          }
          if (
            request.argv[0] === "git" &&
            ((mergeMode === "native-worktree" && request.argv[3] === "merge" && request.argv[4] === "--ff-only") ||
              (mergeMode === "native-ref" &&
                request.argv[3] === "update-ref" &&
                request.argv[4] === "refs/heads/main") ||
              (mergeMode === "native-remote" && request.argv[3] === "push"))
          ) {
            mergeRuns += 1
          }
          return process.run(request)
        },
      }
      const merge =
        mergeMode === "configured"
          ? configuredMergeStep<Checked>({
              inject: { process: authorityProcess },
              repo,
              command: ["merge-must-not-run"],
            })
          : gitMergeStep<Checked>({ inject: { process: authorityProcess }, repo })
      const outcome = await merge(
        {
          ...checkInput,
          step: "merge",
          index: 1,
          shape: { results: { check: checked.output } },
        },
        { id: "J-merge", attempt: 1, runner: "test", signal: canceled.signal },
      )

      expect(canceled.signal.aborted).toBe(true)
      expect(outcome).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "merge-canceled" } })
      expect(mergeRuns).toBe(0)
      const mergedSha =
        mergeMode === "native-remote"
          ? (await git(repo, ["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0]
          : await git(repo, ["rev-parse", "main"])
      expect(mergedSha).toBe(baseSha)
    },
  )

  it("preserves canceled authority when another process merges the same native candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    const checkInput = {
      run: "R1",
      step: "check",
      index: 0,
      prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
      shape: { results: {} },
    } satisfies StepExecution<ChangeShape>
    const checked = await gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] })(
      checkInput,
      { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    if (checked.status !== "completed" || checked.conclusion !== "success") throw new Error("check did not pass")

    const canceled = new AbortController()
    let concurrentMerge = false
    const authorityProcess: Pick<Process, "run"> = {
      async run(request) {
        if (
          !concurrentMerge &&
          request.argv[0] === "git" &&
          request.argv[3] === "config" &&
          request.argv.includes("submodule.alternateLocation")
        ) {
          concurrentMerge = true
          await git(repo, ["push", "-q", "origin", `${featureSha}:refs/heads/main`])
          canceled.abort()
        }
        return process.run(request)
      },
    }
    const outcome = await gitMergeStep<Checked>({ inject: { process: authorityProcess }, repo })(
      {
        ...checkInput,
        step: "merge",
        index: 1,
        shape: { results: { check: checked.output } },
      },
      { id: "J-merge", attempt: 1, runner: "test", signal: canceled.signal },
    )

    expect(concurrentMerge).toBe(true)
    expect(await git(remote, ["rev-parse", "main"])).toBe(featureSha)
    expect(outcome).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "merge-canceled" } })
  })

  it("reconciles a native root push that merged despite its process reporting failure", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let mergedSha: string | undefined
    const postPushFailure: Pick<Process, "run"> = {
      async run(request) {
        const result = await process.run(request)
        const refspec = request.argv.find((argument) => argument.endsWith(":refs/heads/main"))
        if (request.argv[0] !== "git" || request.argv[3] !== "push" || refspec === undefined) return result
        mergedSha = refspec.slice(0, refspec.indexOf(":"))
        return { ...result, exitCode: 19, stderr: "transport lost the success acknowledgement" }
      },
    }
    await using app = await checkedQueue(postPushFailure, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(mergedSha).toBeDefined()
    expect(await git(remote, ["rev-parse", "main"])).toBe(mergedSha)
    expect(run, JSON.stringify(run, null, 2)).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: mergedSha },
    })
  })

  it("reconciles the authoritative merge after a delegated merge reports a post-push failure", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
      { revision: "check-v1", output: GitCheckResultEvidenceSchema },
    )
    const merge = withMerge(
      configuredMergeStep<Checked>({
        inject: { process },
        repo,
        command: shellCommand(
          'git merge --no-ff --no-edit "$YRD_SHA" && git commit --amend --no-edit && ' +
            "git push origin HEAD:refs/heads/main; exit 19",
        ),
      }),
      { revision: "delegated-merge-v1" },
    )
    const queue = withQueue({
      steps: [check, merge] as const,
      resolveBaseSha: (base) => queueBaseSha(repo, base),
    })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), {
      inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const mergedSha = await git(repo, ["rev-parse", "refs/remotes/origin/main"])
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") throw new Error("check did not pass")

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: mergedSha, baseSha: mergedSha },
    })
    expect(await git(repo, ["merge-base", "--is-ancestor", run.integration!.commit, "refs/remotes/origin/main"])).toBe(
      "",
    )
    expect(mergedSha).not.toBe(GitCheckEvidenceSchema.parse(checkJob.output).candidateSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "integrated",
      integration: { commit: mergedSha, baseSha: mergedSha },
    })
  })

  it("reports a broken post-merge ancestry probe instead of claiming the candidate did not merge", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    let commandRuns = 0
    let brokenProbes = 0
    const brokenAncestryProbe: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "true") commandRuns += 1
        if (
          commandRuns >= 2 &&
          request.argv[0] === "git" &&
          request.argv[3] === "merge-base" &&
          request.argv[4] === "--is-ancestor" &&
          request.argv[5] === featureSha
        ) {
          brokenProbes += 1
          return Promise.resolve({
            exitCode: 128,
            signal: null,
            stdout: "",
            stderr: "fatal: corrupt commit graph during merge verification",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(brokenAncestryProbe, repo, ["true"], { mergeCommand: ["true"] })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(commandRuns).toBe(2)
    expect(brokenProbes).toBe(1)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "merge-failed",
        message: expect.stringContaining("fatal: corrupt commit graph during merge verification"),
      },
    })
    expect(run.error?.message).not.toContain("does not contain")
  })

  it("keeps the submitted payload when configured merge cannot refresh post-command authority", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let successfulRefreshes = 0
    let refusalAttempts = 0
    const unavailableAfterCommand: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          if (successfulRefreshes < 2) {
            successfulRefreshes += 1
            return process.run(request)
          }
          refusalAttempts += 1
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "origin unavailable after configured command",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process: unavailableAfterCommand }, repo, command: ["test", "-f", "feature.txt"] }),
      { revision: "check-v1", output: GitCheckResultEvidenceSchema },
    )
    const merge = withMerge(
      configuredMergeStep<Checked>({
        inject: { process: unavailableAfterCommand },
        repo,
        command: shellCommand('git push origin "$YRD_CANDIDATE_SHA":refs/heads/main'),
      }),
      { revision: "delegated-merge-v1" },
    )
    const queue = withQueue({
      steps: [check, merge] as const,
      resolveBaseSha: (base) => queueBaseSha(repo, base),
    })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), {
      inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(successfulRefreshes).toBe(2)
    expect(refusalAttempts).toBe(3)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        message: expect.stringContaining("after 3 attempts"),
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    expect(run.steps[1]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        message: expect.stringContaining("after 3 attempts"),
        evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
      },
    })
    expect(run.steps[1]?.job).not.toHaveProperty("output")
    expect(app.queue.checks(["PR1"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "merge",
          error: expect.objectContaining({
            code: "queue-environment-refused",
            evidence: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
          }),
        }),
      ]),
    )
    expect(await git(remote, ["rev-parse", "main"])).toBe(checked.candidateSha)
    expect(changeFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "submitted",
    })
  })


  it("fails a delegated merge command that exits zero without merging the change", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
      { revision: "check-v1", output: GitCheckResultEvidenceSchema },
    )
    const merge = withMerge(configuredMergeStep<Checked>({ inject: { process }, repo, command: ["true"] }), {
      revision: "delegated-merge-v1",
    })
    const queue = withQueue({
      steps: [check, merge] as const,
      resolveBaseSha: (base) => queueBaseSha(repo, base),
    })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), {
      inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    expect((await app.queue.run({ prs: ["PR1"] }, runtime))[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "merge-command-did-not-land" },
    })
    expect(await git(repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/landing-attempts"])).toBe("")
  })
})

describe("configuredCommandStep — a timed-out command is a NAMED timeout failure (21012 S1)", () => {
  it("fails with <purpose>-timeout naming the bound, not a generic exit red", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-cmd-timeout-"))
    roots.push(cwd)
    await using process = createProcess({ cwd, killGraceMs: 500 })
    const runner = configuredCommandStep<ChangeShape>({
      inject: { process },
      command: ["sleep", "30"],
      cwd,
      purpose: "check",
      artifactRoot: join(cwd, "artifacts"),
      timeoutMs: 500,
    })
    const outcome = await runner(
      {
        run: "run-1",
        step: "check",
        prs: [{ id: "pr-1", base: "main", headSha: "a".repeat(40) }],
        targetSha: "a".repeat(40),
      } as unknown as StepExecution<ChangeShape>,
      { attempt: 1 } as never,
    )
    expect(outcome.status).toBe("completed")
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") return
    expect(outcome.error.code).toBe("check-timeout")
    expect(outcome.error.message).toContain("500ms wall-clock bound")
    const evidence = CommandEvidenceSchema.parse(outcome.output)
    expect(evidence).toMatchObject({ timedOut: true, stageVerdict: "TIMED_OUT", durationMs: expect.any(Number) })
    expect(outcome.error.message).not.toContain(cwd)
  }, 15_000)
})
