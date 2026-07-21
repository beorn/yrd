/**
 * @failure Git-backed Queue steps can check one candidate and merge another or lose durable command evidence.
 * @level l2
 * @consumer @yrd/queue Git step adapters
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveRelativeSubmoduleOrigin } from "../src/submodule-origin.ts"
import { createBayJobDefs, currentPRRev, prDeliveryState, withBays, type BayWorkspace, type PR } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess, shellCommand, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createLogger } from "loggily"
import * as z from "zod"
import {
  CommandEvidenceSchema,
  GitCheckEvidenceSchema,
  GitCheckResultEvidenceSchema,
  IntegrationProofSchema,
  configuredCommandStep,
  configuredMergeStep,
  createGitPRRecutter,
  gitCheckStep,
  gitMergeStep,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type GitCheckEvidence,
  type GitCheckResultEvidence,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"

const roots: string[] = []
const runtime = { runner: "local", leaseMs: 60_000 }
const authoredGitlinksEnv = { ...globalThis.process.env, YRD_ALLOW_AUTHORED_GITLINKS: "1" }
const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`
type Checked = AddStepResult<PRShape, "check", GitCheckResultEvidence>

function prFacts(pr: PR | undefined) {
  if (pr === undefined) throw new Error("expected PR")
  const revision = currentPRRev(pr)
  return {
    ...pr,
    status: prDeliveryState(pr),
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

  await writeFile(join(module, "version.txt"), `${options.candidateVersion}\n`)
  await git(module, ["commit", "-qam", "candidate"])
  const moduleSha = await git(module, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-qc", "issue/feature"])
  await git(join(repo, "dep"), ["fetch", "-q", "origin"])
  await git(join(repo, "dep"), ["checkout", "-q", moduleSha])
  await git(repo, ["add", "dep"])
  if (options.splitCarrier === true) await git(repo, ["commit", "-qm", "feature dependency"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
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

async function divergentSubmoduleRepository(kind: "clean" | "conflict"): Promise<{
  repo: string
  module: string
  moduleBaseSha: string
  rootBaseSha: string
  rootCurrentSha: string
  featureSha: string
}> {
  const { repo } = await repository()
  const module = join(repo, "..", `composition-module-${kind}`)
  await Bun.$`git init -q -b main ${module}`
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(module, "notes.md"), "top\nmiddle\nbottom\n")
  await git(module, ["add", "notes.md"])
  await git(module, ["commit", "-qm", "base"])
  const baseSha = await git(module, ["rev-parse", "HEAD"])

  await git(module, ["switch", "-qc", "current"])
  await writeFile(
    join(module, "notes.md"),
    kind === "clean" ? "top-current\nmiddle\nbottom\n" : "top\ncurrent\nbottom\n",
  )
  await git(module, ["commit", "-qam", "current"])
  const currentSha = await git(module, ["rev-parse", "HEAD"])

  await git(module, ["switch", "-qc", "incoming", baseSha])
  await writeFile(
    join(module, "notes.md"),
    kind === "clean" ? "top\nmiddle\nbottom-incoming\n" : "top\nincoming\nbottom\n",
  )
  await git(module, ["commit", "-qam", "incoming"])
  const incomingSha = await git(module, ["rev-parse", "HEAD"])
  await git(module, ["switch", "-q", "main"])

  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dependency"])
  const rootBaseSha = await git(repo, ["rev-parse", "HEAD"])
  await git(join(repo, "dep"), ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])

  await git(join(repo, "dep"), ["checkout", "-q", currentSha])
  await git(repo, ["add", "dep"])
  await git(repo, ["commit", "-qm", "advance current dependency"])
  const rootCurrentSha = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-qc", "issue/feature", rootBaseSha])
  await git(join(repo, "dep"), ["checkout", "-q", incomingSha])
  await git(repo, ["add", "dep"])
  await git(repo, ["commit", "-qm", "advance incoming dependency"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "update", "-q"])
  return { repo, module, moduleBaseSha: baseSha, rootBaseSha, rootCurrentSha, featureSha }
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

  await git(repo, ["switch", "-qc", "issue/feature"])
  for (const [path, sha] of [
    ["dep-a", first],
    ["dep-b", second],
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
async function directRecutBaseChaseRepository(): Promise<{ repo: string; baseSha: string; featureSha: string }> {
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

const unusedWorkspace: BayWorkspace = {
  revision: "unused-workspace-v1",
  provision: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
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
    env?: NodeJS.ProcessEnv
    environmentOverrides?: Readonly<Record<string, string>>
    environmentPassthrough?: readonly string[]
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
      ...(options.waiting ? { runner: "waiting" as const } : {}),
      ...(options.checkoutParent === undefined ? {} : { checkoutParent: options.checkoutParent }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.environmentOverrides === undefined ? {} : { environmentOverrides: options.environmentOverrides }),
      ...(options.environmentPassthrough === undefined
        ? {}
        : { environmentPassthrough: options.environmentPassthrough }),
    }),
    {
      revision: `check:${JSON.stringify(command)}:${options.waiting === true}`,
      output: GitCheckResultEvidenceSchema,
      ...(options.classification === undefined ? {} : { classification: options.classification }),
    },
  )
  const merge = withMerge(
    gitMergeStep<Checked>({ inject: { process }, repo, ...(options.env === undefined ? {} : { env: options.env }) }),
    { revision: "git-merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: options.batch ?? 1,
    resolveBaseSha: (base) => queueBaseSha(repo, base),
  })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
  })
}

async function expectLanded(repo: string, evidence: GitCheckEvidence): Promise<void> {
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
  it("recuts one direct payload as an exact direct child and refuses overlapping authority", async () => {
    const { repo, candidate } = await repository("candidate")
    const oldBaseSha = await git(repo, ["rev-parse", "main"])
    await writeFile(join(repo, "upstream.txt"), "upstream\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])
    const currentBaseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const recutter = createGitPRRecutter({ inject: { process }, repo })

    const result = await recutter.recut({
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
      recutter.recut({
        id: "PR2",
        branch: "issue/candidate",
        base: "main",
        revision: 1,
        headSha: candidate,
        baseSha: oldBaseSha,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "refusal", code: "recut-conflict", message: expect.stringContaining("candidate.txt") },
    })
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it.each([
    { certificate: "exact", tree: "exact", patch: "exact", valid: true },
    { certificate: "stale tree", tree: "stale", patch: "exact", valid: false },
    { certificate: "stale patch", tree: "exact", patch: "stale", valid: false },
  ] as const)("replays a current direct recut with an $certificate certificate", async ({ patch, tree, valid }) => {
    const { repo, candidate } = await repository("candidate")
    const oldBaseSha = await git(repo, ["rev-parse", "main"])
    await writeFile(join(repo, "upstream.txt"), "upstream\n")
    await git(repo, ["add", "upstream.txt"])
    await git(repo, ["commit", "-qm", "advance authority"])
    await using process = createProcess()
    const recutter = createGitPRRecutter({ inject: { process }, repo })
    const input = {
      id: "PR1",
      branch: "issue/candidate",
      base: "main",
      revision: 1,
      headSha: candidate,
      baseSha: oldBaseSha,
    } as const
    const first = await recutter.recut(input)

    const request = recutter.recut({
      ...input,
      current: {
        revision: 2,
        fromRevision: 1,
        headSha: first.headSha,
        baseSha: first.baseSha,
        treeSha: tree === "exact" ? first.treeSha : "0".repeat(40),
        patchId: patch === "exact" ? first.patchId : "f".repeat(40),
      },
    })
    if (valid) {
      await expect(request).resolves.toMatchObject({
        headSha: first.headSha,
        baseSha: first.baseSha,
        treeSha: first.treeSha,
        patchId: first.patchId,
        unchanged: true,
      })
    } else {
      await expect(request).rejects.toMatchObject({
        failure: {
          kind: "refusal",
          code: "recut-certificate",
          message: expect.stringContaining("patch/tree certificate"),
        },
      })
    }
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("derives direct recut certificates from raw blobs despite a canonicalizing textconv", async () => {
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
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
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
    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
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

    const result = await createGitPRRecutter({ inject: { process }, repo }).recut({
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

  it("recuts an authored root after a certified same-issue source superseded its gitlink", async () => {
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
      doctrineText(["Validate admitted work.", "Receipt marker: �(", "Keep it flowing."]),
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
        "Receipt marker: �(",
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
        "Receipt marker: �(",
        "Keep it flowing.",
      ]),
    )
    await git(repo, ["add", "dep", "doctrine.md"])
    await git(repo, ["commit", "-qm", "authored root"])
    const authoredHead = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["submodule", "update", "--init", "--recursive"])
    await using delegate = createProcess()
    let afterRebase: ((path: string) => Promise<void>) | undefined
    const process = {
      run: async (request: ProcessRequest): Promise<ProcessResult> => {
        const result = await delegate.run(request)
        if (result.exitCode === 0 && request.argv.includes("rebase") && afterRebase !== undefined) {
          const mutate = afterRebase
          afterRebase = undefined
          await mutate(request.cwd ?? repo)
        }
        return result
      },
    }
    const recutter = createGitPRRecutter({ inject: { process }, repo })
    const input = {
      id: "PR1",
      branch: "issue/root",
      base: "main",
      revision: 1,
      headSha: authoredHead,
      baseSha: currentBase,
    }
    await expect(recutter.recut(input)).rejects.toThrow(
      /target root '.+' pins submodule 'dep' to '.+'; replayed authored root '.+' pins it to '.+'; ancestry walk failed because neither submodule commit is an ancestor of the other/u,
    )

    const currentCompositions = [
      {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "main",
            baseSha: composedTip,
            tipSha: currentPin,
            payload: ["repair.ts"],
          },
        ],
      },
      {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "main",
            baseSha: composedBase,
            tipSha: composedTip,
            payload: ["source-a.ts", "source-b.ts"],
          },
        ],
      },
    ] as const
    const result = await recutter.recut({ ...input, currentCompositions })

    expect(result).toMatchObject({
      baseSha: currentBase,
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      treeSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
    })
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(currentBase)
    expect(await git(repo, ["diff", "--name-only", currentBase, result.headSha])).toBe("doctrine.md")
    const recutDoctrine = await git(repo, ["show", `${result.headSha}:doctrine.md`])
    expect(recutDoctrine).toContain("generated `current_command` verbatim")
    expect(recutDoctrine).toContain("For authored roots, draft then recut the same PR")
    expect(await git(repo, ["ls-tree", result.headSha, "dep"])).toContain(currentPin)

    await git(repo, ["switch", "-qc", "issue/root-multi", sourceBase])
    await git(join(repo, "dep"), ["checkout", "-q", sourceTip])
    await git(repo, ["add", "dep"])
    await git(repo, ["commit", "-qm", "authored root pin"])
    await writeFile(
      join(repo, "doctrine.md"),
      doctrineText([
        "Validate admitted work.",
        "Execute the generated `current_command` verbatim.",
        "For authored roots, draft then recut the same PR.",
        "Receipt marker: �(",
        "Keep it flowing.",
      ]),
    )
    await git(repo, ["add", "doctrine.md"])
    await git(repo, ["commit", "-qm", "authored root doctrine"])
    const multiCommitHead = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await git(repo, ["submodule", "update", "--init", "--recursive"])
    await expect(
      recutter.recut({
        ...input,
        branch: "issue/root-multi",
        headSha: multiCommitHead,
        currentCompositions,
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "payload-certificate",
        message: expect.stringContaining("union-merge recut requires one root commit"),
      },
    })

    const validBytes = new TextEncoder().encode(recutDoctrine)
    const marker = [0xef, 0xbf, 0xbd, 0x28]
    const markerIndex = validBytes.findIndex((byte, index) =>
      marker.every((part, offset) => validBytes[index + offset] === part),
    )
    expect(markerIndex).toBeGreaterThanOrEqual(0)
    const tamperedBytes = new Uint8Array(validBytes.length - 2)
    tamperedBytes.set(validBytes.slice(0, markerIndex), 0)
    tamperedBytes.set([0xc3, 0x28], markerIndex)
    tamperedBytes.set(validBytes.slice(markerIndex + marker.length), markerIndex + 2)
    afterRebase = async (path) => {
      await writeFile(join(path, "doctrine.md"), tamperedBytes)
      await git(path, ["add", "doctrine.md"])
      await git(path, [
        "-c",
        "user.name=Yrd Queue",
        "-c",
        "user.email=yrd-queue@example.invalid",
        "commit",
        "--amend",
        "-qm",
        "tamper union output",
      ])
    }
    await expect(recutter.recut({ ...input, currentCompositions })).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "payload-certificate",
        message: expect.stringContaining("did not preserve deterministic union identity"),
      },
    })
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  }, 30_000)

  it("refuses a recorded base with ambiguous source merge bases", async () => {
    const { repo } = await repository()
    await git(repo, ["switch", "-qc", "issue/left"])
    await writeFile(join(repo, "left.txt"), "left\n")
    await git(repo, ["add", "left.txt"])
    await git(repo, ["commit", "-qm", "left"])
    const left = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-qc", "issue/right", "main"])
    await writeFile(join(repo, "right.txt"), "right\n")
    await git(repo, ["add", "right.txt"])
    await git(repo, ["commit", "-qm", "right"])
    await git(repo, ["switch", "-q", "issue/left"])
    await git(repo, ["merge", "-q", "--no-ff", "issue/right", "-m", "left merge"])
    const leftMerge = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "issue/right"])
    await git(repo, ["merge", "-q", "--no-ff", left, "-m", "right merge"])
    const rightMerge = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["branch", "-f", "main", leftMerge])
    expect((await git(repo, ["merge-base", "--all", leftMerge, rightMerge])).split("\n")).toHaveLength(2)
    await using process = createProcess()

    await expect(
      createGitPRRecutter({ inject: { process }, repo }).recut({
        id: "PR1",
        branch: "issue/right",
        base: "main",
        revision: 1,
        headSha: rightMerge,
        baseSha: leftMerge,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "refusal", code: "recut-lineage", message: expect.stringContaining("one source merge base") },
    })
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
  })

  it("admits a mechanically certified two-commit recut that preserves an authored root gitlink", async () => {
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
    const recut = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })
    expect(await git(repo, ["rev-list", "--count", `${recut.baseSha}..${recut.headSha}`])).toBe("2")
    expect(await git(repo, ["rev-parse", `${recut.headSha}~2`])).toBe(recut.baseSha)
    expect(
      (await git(repo, ["log", "--reverse", "--format=%s", `${recut.baseSha}..${recut.headSha}`])).split("\n"),
    ).toEqual(["feature dependency", "feature"])
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main", baseSha, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recut.headSha,
      baseSha: recut.baseSha,
      treeSha: recut.treeSha,
      patchId: recut.patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    await git(repo, ["fetch", "-q", "origin", "main"])
    expect(await git(repo, ["ls-tree", "FETCH_HEAD", "dep"])).toBe(await git(repo, ["ls-tree", recut.headSha, "dep"]))
  })

  it("recuts one composition revision onto the authoritative root and returns its exact certificate", async () => {
    const { repo, module, oldPinSha, newPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    const oldRootBaseSha = await git(repo, ["rev-parse", `${rootBaseSha}^`])
    await using process = createProcess()
    const recutter = createGitPRRecutter({ inject: { process }, repo })

    const input = {
      id: "PR1",
      branch: "issue/source",
      base: "main",
      revision: 1,
      headSha: oldRootBaseSha,
      baseSha: oldRootBaseSha,
      composition: {
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
      },
    } as const
    const result = await recutter.recut(input)

    expect(result).toMatchObject({
      headSha: rootBaseSha,
      baseSha: rootBaseSha,
      treeSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
      unchanged: false,
      composition: {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: expect.stringMatching(/^refs\/heads\/yrd\/candidates\/[0-9a-f]{40}$/u),
            baseSha: newPinSha,
            tipSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
            payload: ["src/candidate.ts"],
          },
        ],
      },
    })
    const rewritten = result.composition?.sources[0]
    expect(rewritten).toBeDefined()
    expect(await git(repo, ["ls-tree", result.treeSha, "dep"])).toContain(rewritten!.tipSha)
    expect(await git(module, ["diff", "--name-only", newPinSha, rewritten!.tipSha])).toBe("src/candidate.ts")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
    const current = {
      revision: 2,
      headSha: result.headSha,
      baseSha: result.baseSha,
      treeSha: result.treeSha,
      patchId: result.patchId,
      fromRevision: 1,
      composition: result.composition,
    } as const
    const unchanged = {
      headSha: result.headSha,
      baseSha: result.baseSha,
      treeSha: result.treeSha,
      patchId: result.patchId,
      composition: result.composition,
      unchanged: true,
    } as const
    await expect(recutter.recut({ ...input, current })).resolves.toMatchObject(unchanged)
    const candidateBranch = result.composition?.sources[0]?.branch
    if (candidateBranch === undefined) throw new Error("missing immutable source candidate")
    await git(module, ["update-ref", "-d", candidateBranch])
    await expect(recutter.recut({ ...input, current })).resolves.toMatchObject(unchanged)
    await expect(
      recutter.recut({
        ...input,
        current: { ...current, treeSha: "0".repeat(40) },
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "recut-certificate",
        message: expect.stringContaining("composed patch/tree certificate"),
      },
    })
    await expect(
      recutter.recut({
        ...input,
        current: { ...current, patchId: "f".repeat(40) },
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "recut-certificate",
        message: expect.stringContaining("composed patch/tree certificate"),
      },
    })
    await expect(
      recutter.recut({
        ...input,
        current: { ...current, headSha: oldRootBaseSha },
      }),
    ).rejects.toMatchObject({
      failure: {
        kind: "refusal",
        code: "recut-certificate",
        message: expect.stringContaining("head does not match the authoritative base"),
      },
    })
  })

  it.each([
    { certificate: "exact", tree: "exact", patch: "exact", valid: true },
    { certificate: "mismatched tree", tree: "mismatched", patch: "exact", valid: false },
    { certificate: "mismatched patch", tree: "exact", patch: "mismatched", valid: false },
  ] as const)("admits a composed recut only when its $certificate replays", async ({ patch, tree, valid }) => {
    const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    const oldRootBaseSha = await git(repo, ["rev-parse", `${rootBaseSha}^`])
    await using process = createProcess()
    const composition = {
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
    } as const
    const recut = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/source",
      base: "main",
      revision: 1,
      headSha: oldRootBaseSha,
      baseSha: oldRootBaseSha,
      composition,
    })
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: oldRootBaseSha,
      base: "main",
      baseSha: oldRootBaseSha,
      composition,
      draft: true,
    })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recut.headSha,
      baseSha: recut.baseSha,
      treeSha: tree === "exact" ? recut.treeSha : "f".repeat(40),
      patchId: patch === "exact" ? recut.patchId : "e".repeat(40),
      reviewCarried: false,
      composition: recut.composition,
    })
    await app.bays.ready({ pr: "PR1" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    if (valid) {
      expect(run.status, run.error?.message).toBe("completed")
      expect(run.conclusion).toBe("success")
    } else {
      expect(run.status).toBe("completed")
      expect(run.error).toMatchObject({
        code: "recut-certificate",
        message: expect.stringContaining("patch/tree certificate"),
      })
    }
  })

  it("admits a direct recut whose base advanced with a disjoint merge (base-chase re-anchors clean)", async () => {
    const { repo, baseSha, featureSha } = await directRecutBaseChaseRepository()
    await using process = createProcess()
    const recut = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main", baseSha, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recut.headSha,
      baseSha: recut.baseSha,
      treeSha: recut.treeSha,
      patchId: recut.patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })

    // Production refreshes the check identity after a recut when main advances.
    // The admission base may move, but it must not replace the base certified by the recut revision.
    await writeFile(join(repo, "other.txt"), "advanced\n")
    await git(repo, ["add", "other.txt"])
    await git(repo, ["commit", "-qm", "advance base disjoint"])
    const advancedBaseSha = await git(repo, ["rev-parse", "main"])
    expect(advancedBaseSha).not.toBe(baseSha)
    await app.bays.requestChecks({ pr: "PR1", baseSha: advancedBaseSha })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    // The reviewed change re-anchored onto the advanced base and landed alongside it.
    expect(await git(repo, ["show", "main:payload.txt"])).toContain("FIVE")
    expect(await git(repo, ["show", "main:other.txt"])).toContain("advanced")
  })

  it("rejects a direct recut whose advanced base conflicts with the reviewed change", async () => {
    const { repo, baseSha, featureSha } = await directRecutBaseChaseRepository()
    await using process = createProcess()
    const recut = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })
    // Advance the base by re-editing the same line the reviewed change touches.
    await writeFile(join(repo, "payload.txt"), payloadLines("BASE5"))
    await git(repo, ["commit", "-qam", "advance base conflicting"])
    expect(await git(repo, ["rev-parse", "main"])).not.toBe(baseSha)

    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main", baseSha, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recut.headSha,
      baseSha: recut.baseSha,
      treeSha: recut.treeSha,
      patchId: recut.patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })

    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    errors.mockRestore()

    expect(run.status).toBe("completed")
    expect(run.error).toMatchObject({ code: "recut-certificate" })
    // The conflicting change never landed.
    expect(await git(repo, ["show", "main:payload.txt"])).not.toContain("FIVE")
  })

  it("rejects a direct recut whose advanced base cleanly drifts the reviewed patch identity", async () => {
    const { repo, baseSha, featureSha } = await directRecutBaseChaseRepository()
    await using process = createProcess()
    const recut = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/feature",
      base: "main",
      revision: 1,
      headSha: featureSha,
      baseSha,
    })
    // Advance the base by editing an adjacent line: the merge is clean, but the
    // reviewed change re-anchors with different surrounding context, so its stable
    // patch identity drifts and the recut must not be admitted.
    await writeFile(join(repo, "payload.txt"), payloadLines("5", "THREE"))
    await git(repo, ["commit", "-qam", "advance base adjacent drift"])
    expect(await git(repo, ["rev-parse", "main"])).not.toBe(baseSha)

    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main", baseSha, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recut.headSha,
      baseSha: recut.baseSha,
      treeSha: recut.treeSha,
      patchId: recut.patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })

    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    errors.mockRestore()

    expect(run.status).toBe("completed")
    expect(run.error).toMatchObject({ code: "recut-certificate" })
    expect(await git(repo, ["show", "main:payload.txt"])).not.toContain("FIVE")
  })

  it("admits a composed recut whose root base advanced (composite patch identity survives)", async () => {
    const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    const oldRootBaseSha = await git(repo, ["rev-parse", `${rootBaseSha}^`])
    await using process = createProcess()
    const composition = {
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
    } as const
    const recut = await createGitPRRecutter({ inject: { process }, repo }).recut({
      id: "PR1",
      branch: "issue/source",
      base: "main",
      revision: 1,
      headSha: oldRootBaseSha,
      baseSha: oldRootBaseSha,
      composition,
    })
    expect(recut.baseSha).toBe(rootBaseSha)
    // Advance the authoritative root base with a disjoint root change (dep pin untouched).
    await writeFile(join(repo, "unrelated-root.txt"), "advanced\n")
    await git(repo, ["add", "unrelated-root.txt"])
    await git(repo, ["commit", "-qm", "advance root base"])
    expect(await git(repo, ["rev-parse", "main"])).not.toBe(rootBaseSha)

    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: oldRootBaseSha,
      base: "main",
      baseSha: oldRootBaseSha,
      composition,
      draft: true,
    })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recut.headSha,
      baseSha: recut.baseSha,
      treeSha: recut.treeSha,
      patchId: recut.patchId,
      reviewCarried: false,
      composition: recut.composition,
    })
    await app.bays.ready({ pr: "PR1" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    // The advanced root file and the composed dep pin both landed.
    expect(await git(repo, ["show", "main:unrelated-root.txt"])).toContain("advanced")
  })

  it("auto-restacks a disjoint source payload and composes the exact wrapper", async () => {
    const { repo, module, oldPinSha, newPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    await using process = createProcess()
    const proofCommands: string[][] = []
    const proofProcess: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && (request.argv.includes("patch-id") || request.argv.includes("range-diff"))) {
          proofCommands.push([...request.argv])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(
      proofProcess,
      repo,
      shellCommand(
        "git -c protocol.file.allow=always submodule update --init --recursive && " +
          "test -f dep/src/candidate.ts && test -f dep/src/upstream.ts",
      ),
    )
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
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
      },
    })
    await git(module, ["switch", "-q", "issue/source"])
    await writeFile(join(module, "src/later.ts"), "export const later = true\n")
    await git(module, ["add", "src/later.ts"])
    await git(module, ["commit", "-qm", "later source work"])

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    const check = run.steps[0]?.job
    if (check?.status !== "completed" || check.conclusion !== "success") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(check.output)
    expect(evidence.sourceRewrites).toEqual([
      {
        repo: "dep",
        branch: "issue/source",
        oldBaseSha: oldPinSha,
        oldTipSha: sourceTipSha,
        newBaseSha: newPinSha,
        newTipSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        candidateRef: expect.stringMatching(/^refs\/heads\/yrd\/candidates\/[0-9a-f]{40}$/u),
        patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
        rangeDiff: "=",
        payload: ["src/candidate.ts"],
      },
    ])
    expect(proofCommands.filter((command) => command.includes("patch-id"))).toEqual([
      expect.arrayContaining(["patch-id", "--stable"]),
      expect.arrayContaining(["patch-id", "--stable"]),
    ])
    expect(proofCommands.filter((command) => command.includes("range-diff"))).toEqual([
      expect.arrayContaining(["range-diff", "--no-color", "--no-dual-color", "--no-patch"]),
    ])
    const landedTree = await git(repo, ["ls-tree", "main", "dep"])
    const landedPinSha = landedTree.split(/\s+/u)[2]
    expect(landedPinSha).toBe(evidence.sourceRewrites?.[0]?.newTipSha)
    expect(await git(join(repo, "dep"), ["diff", "--name-only", newPinSha, landedPinSha!])).toBe("src/candidate.ts")
    expect(await git(repo, ["rev-parse", "main^"])).toBe(rootBaseSha)
    expect(await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "main"])).toBe("dep")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
    expect(await git(join(repo, "dep"), ["rev-parse", "HEAD"])).toBe(landedPinSha)
    expect(run.integration?.sourceRewrites).toEqual(evidence.sourceRewrites)
  })

  it.each([
    { proof: "stable patch identity", command: "patch-id", detail: "stable patch identity" },
    { proof: "range-diff equivalence", command: "range-diff", detail: "range-diff equivalent" },
  ] as const)("rejects a rewritten source when its $proof certificate is not exact", async ({ command, detail }) => {
    const { repo, module, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    await using process = createProcess()
    let patchIdCalls = 0
    const divergentProof: Pick<Process, "run"> = {
      async run(request) {
        const result = await process.run(request)
        if (request.argv[0] !== "git" || !request.argv.includes(command)) return result
        if (command === "patch-id" && ++patchIdCalls < 2) return result
        const stdout =
          command === "patch-id"
            ? `${result.stdout[0] === "0" ? "1" : "0"}${result.stdout.slice(1)}`
            : result.stdout.replace(" = ", " ! ")
        return { ...result, stdout }
      },
    }
    await using app = await checkedQueue(divergentProof, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
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
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "payload-certificate", message: expect.stringContaining(detail) },
    })
    expect(await git(repo, ["rev-parse", "main"])).toBe(rootBaseSha)
    expect(await git(module, ["for-each-ref", "--format=%(refname)", "refs/heads/yrd/candidates"])).toBe("")
  })

  it("pins distinct immutable source Candidates for a same-repository batch", async () => {
    const { repo, module, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    await git(module, ["switch", "-qc", "issue/source-two", oldPinSha])
    await mkdir(join(module, "src"), { recursive: true })
    await writeFile(join(module, "src/second.ts"), "export const second = true\n")
    await git(module, ["add", "src/second.ts"])
    await git(module, ["commit", "-qm", "second candidate payload"])
    const secondTipSha = await git(module, ["rev-parse", "HEAD"])
    await git(repo, ["branch", "issue/source-two", rootBaseSha])

    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        "git -c protocol.file.allow=always submodule update --init --recursive && " +
          "test -f dep/src/candidate.ts && test -f dep/src/second.ts",
      ),
      { batch: 2 },
    )
    for (const [branch, tipSha, payload] of [
      ["issue/source", sourceTipSha, "src/candidate.ts"],
      ["issue/source-two", secondTipSha, "src/second.ts"],
    ] as const) {
      await app.bays.submit({
        branch,
        headSha: rootBaseSha,
        base: "main",
        baseSha: rootBaseSha,
        composition: {
          version: 1,
          sources: [{ repo: "dep", branch, baseSha: oldPinSha, tipSha, payload: [payload] }],
        },
      })
    }

    const run = (await app.queue.run({ prs: ["PR1", "PR2"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    const check = run.steps[0]?.job
    if (check?.status !== "completed" || check.conclusion !== "success") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(check.output)
    const rewrites = evidence.sourceRewrites ?? []
    expect(rewrites).toHaveLength(2)
    expect(new Set(rewrites.map((rewrite) => rewrite.candidateRef)).size).toBe(2)
    for (const rewrite of rewrites) {
      expect(rewrite.candidateRef).toBe(`refs/heads/yrd/candidates/${rewrite.newTipSha}`)
      expect(await git(join(repo, rewrite.repo), ["rev-parse", rewrite.candidateRef])).toBe(rewrite.newTipSha)
    }
  })

  it("rolls back a remote root landing when an immutable source Candidate ref disappears", async () => {
    const { repo, module, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    const remote = join(repo, "..", "root-origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/source"])

    await using process = createProcess()
    let raced = false
    const racingProcess: Pick<Process, "run"> = {
      async run(request) {
        if (!raced && request.argv.some((argument) => argument.endsWith(":refs/heads/main"))) {
          raced = true
          const candidateRef = await git(module, ["for-each-ref", "--format=%(refname)", "refs/heads/yrd/candidates"])
          if (candidateRef === "") throw new Error("source Candidate was not published before the root push")
          await git(module, ["update-ref", "-d", candidateRef])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(racingProcess, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
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
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(raced).toBe(true)
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "invalid-candidate" } })
    expect(await git(remote, ["rev-parse", "main"])).toBe(rootBaseSha)
  })

  it("rejects an uncertified authored gitlink wrapper with same-PR recut guidance", async () => {
    const { repo, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
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
        code: "authored-gitlink",
        message: expect.stringMatching(
          /yrd pr submit <branch> --draft.*yrd pr recut PR1 --queue --force.*same PR.*no composition manifest or manual recut/iu,
        ),
      },
    })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: ".", paths: ["dep"] }] },
    })
    // End-to-end through the REAL compose path: the composition refusal projects
    // as a derived needs-author eligibility with the refusal receipt attached,
    // not a plain rejected — so the author is told to re-author, not re-submit.
    const eligibility = app.queue.eligibility("PR1")
    expect(eligibility.reason?.code).toBe("needs-author")
    expect(eligibility.reason?.receipt).toMatchObject({ code: "authored-gitlink" })
  })

  it("redirects an invalid manual composition to the authored-root draft and recut flow", async () => {
    const { repo, candidate } = await repository("candidate")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/candidate",
      headSha: candidate,
      base: "main",
      baseSha,
      composition: {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: "2".repeat(40),
            tipSha: "3".repeat(40),
            payload: ["src/candidate.ts"],
          },
        ],
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "composition-invalid",
        message: expect.stringMatching(
          /yrd pr submit <branch> --draft.*yrd pr recut PR1 --queue.*same PR.*no composition manifest or manual recut/iu,
        ),
      },
    })
  })

  it("bounces an overlapping source payload with the exact repository paths", async () => {
    const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository({
      upstreamPath: "src/candidate.ts",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
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
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "payload-overlap", message: expect.stringContaining("[src/candidate.ts]") },
    })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: "dep", paths: ["src/candidate.ts"] }] },
    })
  })

  it.each(["src/original.ts", "src/renamed.ts"])(
    "treats the rename endpoint %s as an exact overlap",
    async (upstreamPath) => {
      const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository({
        sourcePath: "src/original.ts",
        sourceRenameTo: "src/renamed.ts",
        upstreamPath,
      })
      await using process = createProcess()
      await using app = await checkedQueue(process, repo, ["true"])
      await app.bays.submit({
        branch: "issue/source",
        headSha: rootBaseSha,
        base: "main",
        baseSha: rootBaseSha,
        composition: {
          version: 1,
          sources: [
            {
              repo: "dep",
              branch: "issue/source",
              baseSha: oldPinSha,
              tipSha: sourceTipSha,
              payload: ["src/original.ts", "src/renamed.ts"],
            },
          ],
        },
      })

      const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

      expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "payload-overlap" } })
      expect(run.steps[0]?.job).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: { conflicts: [{ repo: "dep", paths: [upstreamPath] }] },
      })
    },
  )

  it("treats a source delete and upstream modify as one exact overlap", async () => {
    const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository({
      sourcePath: "src/delete.ts",
      sourceDelete: true,
      upstreamPath: "src/delete.ts",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: oldPinSha,
            tipSha: sourceTipSha,
            payload: ["src/delete.ts"],
          },
        ],
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "payload-overlap" } })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: "dep", paths: ["src/delete.ts"] }] },
    })
  })

  it("lands a disjoint source delete with exact payload identity", async () => {
    const { repo, oldPinSha, newPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository({
      sourcePath: "src/delete.ts",
      sourceDelete: true,
    })
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        "git -c protocol.file.allow=always submodule update --init --recursive && " +
          "test ! -e dep/src/delete.ts && test -f dep/src/upstream.ts",
      ),
    )
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: oldPinSha,
            tipSha: sourceTipSha,
            payload: ["src/delete.ts"],
          },
        ],
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    const landedPinSha = (await git(repo, ["ls-tree", "main", "dep"])).split(/\s+/u)[2]
    expect(await git(join(repo, "dep"), ["diff", "--name-status", "--no-renames", newPinSha, landedPinSha!])).toBe(
      "D\tsrc/delete.ts",
    )
  })

  it("bounces a disjoint-path Git restack conflict with the exact unmerged path", async () => {
    const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository({
      sourcePath: "src/node",
      upstreamPath: "src/node/child.ts",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: oldPinSha,
            tipSha: sourceTipSha,
            payload: ["src/node"],
          },
        ],
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "restack-conflict" } })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: "dep", paths: ["src/node"] }] },
    })
  })

  it("fails closed when a source payload manifest differs from its materialized diff", async () => {
    const { repo, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: oldPinSha,
            tipSha: sourceTipSha,
            payload: ["src/not-the-payload.ts"],
          },
        ],
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "payload-mismatch" } })
    expect(run.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { conflicts: [{ repo: "dep", paths: ["src/candidate.ts", "src/not-the-payload.ts"] }] },
    })
  })
  it("renews one runner lease only on child progress and recovers a stalled child without merge", async () => {
    type CheckedCommand = AddStepResult<PRShape, "check", z.infer<typeof CommandEvidenceSchema>>
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
        configuredCommandStep<PRShape>({
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
          return {
            status: "completed",
            conclusion: "success" as const,
            output: { commit: "b".repeat(40), baseSha: "b".repeat(40) },
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
      const app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
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
      // the resident heartbeat has not yet sampled, so external recovery owns
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

    expect(outcome).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "candidate-conflict" } })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") return
    const artifacts = (outcome.output as { artifacts?: readonly { name: string; path: string }[] } | undefined)
      ?.artifacts
    expect(artifacts).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/\/R1\/0-check\/attempt-1\/(?:stdout|stderr)\.log$/u),
      }),
    ])
    const artifact = artifacts?.[0]
    expect(artifact === undefined ? false : existsSync(artifact.path)).toBe(true)
    expect(artifact === undefined ? "" : await readFile(artifact.path, "utf8")).toContain("CONFLICT")
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
      } as StepExecution<PRShape>,
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
    } as StepExecution<PRShape>
    const context = { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal }

    expect(() =>
      configuredCommandStep<PRShape>({
        inject: { process },
        command: "printf unsafe" as never,
        cwd,
        purpose: "check",
      }),
    ).toThrow("shellCommand")

    const direct = configuredCommandStep<PRShape>({
      inject: { process },
      command: ["printf", "%s", "literal;$(not-expanded)"],
      cwd,
      purpose: "check",
    })
    const explicitShell = configuredCommandStep<PRShape>({
      inject: { process },
      command: shellCommand("printf shell"),
      cwd,
      purpose: "check",
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
    const step = configuredCommandStep<PRShape>({
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
    } as StepExecution<PRShape>
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
    expect((await readdir(dir)).sort()).toEqual(["output.log", "stderr.log", "stdout.log"])
    expect(Array.from(await readFile(stdoutPath))).toEqual(Array.from(stdout))
    expect(Array.from(await readFile(stderrPath))).toEqual(Array.from(stderr))
    expect(await readFile(outputPath, "utf8")).toBe("first warning\n€ last\n")
  }, 10_000)

  it("grows a real slow command artifact while the child is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-slow-stream-"))
    roots.push(cwd)
    const release = join(cwd, "release")
    const artifactRoot = join(cwd, "artifacts")
    const stdoutPath = join(artifactRoot, "R-slow", "0-check", "attempt-1", "stdout.log")
    const outputPath = join(artifactRoot, "R-slow", "0-check", "attempt-1", "output.log")
    await using process = createProcess()
    const step = configuredCommandStep<PRShape>({
      inject: { process },
      command: shellCommand(
        "printf 'first\\n'; while [ ! -f \"$YRD_RELEASE\" ]; do sleep 0.01; done; printf 'second\\n'",
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
      const step = configuredCommandStep<PRShape>({
        inject: { process: { run: () => Promise.resolve(result) } },
        command: ["false"],
        cwd,
        purpose: "check",
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
    const step = configuredCommandStep<PRShape>({
      inject: { process: { run: () => Promise.resolve(result) } },
      command: ["bun", "run", "check"],
      cwd,
      purpose: "check",
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
        "printf 'src/base.ts:1:1 - baseline\\n'; " +
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
      },
    })
    expect(evidence.candidateSha).toHaveLength(40)
    const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.name, artifact.path]))
    const stdoutArtifact = artifacts.get("stdout")
    const stderrArtifact = artifacts.get("stderr")
    if (stdoutArtifact === undefined || stderrArtifact === undefined) throw new Error("missing command artifacts")
    expect(await readFile(stdoutArtifact, "utf8")).toBe("src/base.ts:1:1 - baseline\nsrc/feature.ts:2:1 - net-new\n")
    expect(await readFile(stderrArtifact, "utf8")).toBe("check stderr\n")
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("passes parent-identical failed diagnostics regardless of order and duplicates", async () => {
    const { repo, feature: featureSha } = await repository("feature")
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "integrated", headSha: featureSha })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "integrated", headSha: featureSha })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("lands the exact audited candidate and its durable artifacts", async () => {
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
    await expectLanded(repo, evidence)
    expect(evidence.exitCode).toBe(0)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toBe("checked\n")
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
  })

  it("lands from origin when the base has no local branch without moving detached HEAD", async () => {
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
    await expectLanded(repo, GitCheckEvidenceSchema.parse(job.output))
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
    const finalLanding = runs.at(-1)?.integration?.commit
    expect(finalLanding).toBeDefined()
    expect(await git(remote, ["rev-parse", "main"])).toBe(finalLanding)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(finalLanding)
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "integrated",
    })
  })

  it("retries authoritative refresh at most three times without changing the PR payload", async () => {
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "integrated",
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
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
      env: authoredGitlinksEnv,
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "scratch-cleanup-failed", message: "cleanup denied" },
    })
  })

  it("passes exact YRD_* variables while scrubbing ambient YRD_* and GIT_* values", async () => {
    await using process = createProcess()
    expect(() =>
      configuredCommandStep<PRShape>({
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
    const step = configuredCommandStep<PRShape>({
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
    const execution = (): StepExecution<PRShape> =>
      ({
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha }],
        shape: { results: {} },
      }) as StepExecution<PRShape>
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
      const step = configuredCommandStep<PRShape>({
        inject: { process },
        command: ["check-env"],
        cwd: ".",
        purpose: "check",
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
      const step = configuredCommandStep<PRShape>({
        inject: { process },
        command: ["check-env"],
        cwd: ".",
        purpose: "check",
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
        configuredCommandStep<PRShape>({
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

  it("checks and lands one combined candidate for a passing batch", async () => {
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
    await expectLanded(repo, GitCheckEvidenceSchema.parse(job.output))
  })

  it("lands the checked candidate through origin without touching a dirty local base checkout", async () => {
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
    expect(await git(repo, ["rev-parse", "main"])).toBe(localMain)
    expect(await Bun.file(join(repo, "operator-wip.txt")).text()).toBe("preserve me\n")
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
    await using app = await checkedQueue(traced, repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status).toBe("completed")
    expect(requests.filter(({ argv }) => argv[0] === "git").every(({ timeoutMs }) => timeoutMs === 30_000)).toBe(true)
    const initializations = requests.filter(
      ({ argv }) => argv[0] === "git" && argv.includes("init") && argv.includes("--bare"),
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
    await using app = await checkedQueue(unsupported, repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

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
      await using app = await checkedQueue(unavailable, fixture.repo, ["true"], { env: authoredGitlinksEnv })
      await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

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
      expect(requests.filter(({ argv }) => argv.includes("--depth=1"))).toHaveLength(1)
      expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
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
      const unavailable: Pick<Process, "run"> = {
        run(request) {
          if (request.argv[0] === "true") configuredCheckRan = true
          if (failure.matches(request.argv)) {
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
      await using app = await checkedQueue(unavailable, fixture.repo, ["true"], { env: authoredGitlinksEnv })
      await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

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
      expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
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
    await using app = await checkedQueue(noOrigin, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

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
            stdout: result.stdout.replace(/(submodule\.[^\n]+\.url\n)[\s\S]*/u, "$1../dep.git"),
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
    await using app = await checkedQueue(noOrigin, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
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
      await using app = await checkedQueue(unreachable, repo, ["true"], { env: authoredGitlinksEnv })
      await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

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
      expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
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
    await using app = await checkedQueue(traced, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-failed", message: expect.stringContaining("has no URL") },
    })
    expect(configuredCheckRan).toBe(false)
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("composes a divergent clean submodule pin into the checked and landed root candidate", async () => {
    const fixture = await divergentSubmoduleRepository("clean")
    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const check = run.steps[0]?.job
    if (check?.status !== "completed" || check.conclusion !== "success") {
      throw new Error(`check was ${check?.status ?? "missing"}`)
    }
    const evidence = GitCheckEvidenceSchema.parse(check.output)

    expect(run.status).toBe("completed")
    expect(evidence.submoduleResolutions).toEqual([
      {
        kind: "compose",
        path: "dep",
        sha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        ref: expect.stringMatching(/^refs\/yrd\/compositions\/[0-9a-f]{64}$/u),
        reviewedBlobs: [
          {
            path: "notes.md",
            oid: expect.stringMatching(/^[0-9a-f]{40}$/u),
            content: "top-current\nmiddle\nbottom-incoming\n",
          },
        ],
      },
    ])
    const resolution = evidence.submoduleResolutions?.[0]
    if (resolution?.kind !== "compose") throw new Error("missing composed submodule evidence")
    expect(await git(fixture.repo, ["ls-tree", "main", "dep"])).toContain(resolution.sha)
    expect(await git(fixture.module, ["rev-parse", resolution.ref])).toBe(resolution.sha)
  }, 20_000)

  it("refuses a real submodule content conflict without pinning or landing a root candidate", async () => {
    const fixture = await divergentSubmoduleRepository("conflict")
    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "submodule-composition-conflict" },
    })
    expect(await git(fixture.repo, ["rev-parse", "main"])).toBe(fixture.rootCurrentSha)
    expect(await git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/candidates"])).toBe("")
    expect(await git(fixture.module, ["for-each-ref", "--format=%(refname)", "refs/yrd/compositions"])).toBe("")
  }, 20_000)

  it("keeps a divergent submodule PR submitted when its full local store is unavailable", async () => {
    const fixture = await divergentSubmoduleRepository("clean")
    await rm(join(fixture.repo, "dep"), { recursive: true, force: true })
    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: {
          kind: "submodule-composition-refusal",
          operation: "compose",
          path: "dep",
          retryable: true,
        },
      },
    })
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "submitted",
      headSha: fixture.featureSha,
    })
    expect(await git(fixture.repo, ["rev-parse", "main"])).toBe(fixture.rootCurrentSha)
    expect(await git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/candidates"])).toBe("")
    expect(await git(fixture.module, ["for-each-ref", "--format=%(refname)", "refs/yrd/compositions"])).toBe("")
  }, 20_000)

  it("keeps a divergent submodule PR submitted when reading conflict stages times out", async () => {
    const fixture = await divergentSubmoduleRepository("clean")
    await using process = createProcess()
    let injected = false
    const unavailable: Pick<Process, "run"> = {
      run(request) {
        if (request.argv.includes("ls-files") && request.argv.includes("--unmerged")) {
          injected = true
          return Promise.resolve({
            exitCode: 124,
            signal: "SIGTERM",
            stdout: "",
            stderr: "conflict index read timed out",
            durationMs: 1,
            timedOut: true,
            stalled: false,
            verdict: "TIMED_OUT",
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailable, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(injected).toBe(true)
    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: {
        code: "queue-environment-refused",
        evidence: { kind: "submodule-composition-refusal", operation: "compose", retryable: true },
      },
    })
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "submitted",
      headSha: fixture.featureSha,
    })
    expect(await git(fixture.repo, ["rev-parse", "main"])).toBe(fixture.rootCurrentSha)
    expect(await git(fixture.repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/candidates"])).toBe("")
    expect(await git(fixture.module, ["for-each-ref", "--format=%(refname)", "refs/yrd/compositions"])).toBe("")
  }, 20_000)

  it("lands the final gitlink after composing the same submodule twice in one batch", async () => {
    const fixture = await divergentSubmoduleRepository("clean")
    await git(fixture.module, ["switch", "-qc", "incoming-two", fixture.moduleBaseSha])
    await writeFile(join(fixture.module, "second.md"), "second incoming\n")
    await git(fixture.module, ["add", "second.md"])
    await git(fixture.module, ["commit", "-qm", "second incoming"])
    const secondIncomingSha = await git(fixture.module, ["rev-parse", "HEAD"])
    await git(fixture.module, ["switch", "-q", "main"])
    await git(fixture.repo, ["switch", "-qc", "issue/feature-two", fixture.rootBaseSha])
    await git(join(fixture.repo, "dep"), ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await git(join(fixture.repo, "dep"), ["checkout", "-q", secondIncomingSha])
    await git(fixture.repo, ["add", "dep"])
    await git(fixture.repo, ["commit", "-qm", "advance second incoming dependency"])
    const secondFeatureSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])
    await git(fixture.repo, ["-c", "protocol.file.allow=always", "submodule", "update", "-q"])

    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"], { batch: 2, env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })
    await app.bays.submit({ branch: "issue/feature-two", headSha: secondFeatureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1", "PR2"] }, runtime))[0]!
    const check = run.steps[0]?.job
    if (check?.status !== "completed" || check.conclusion !== "success") {
      throw new Error(`check was ${check?.status ?? "missing"}`)
    }
    const evidence = GitCheckEvidenceSchema.parse(check.output)
    const resolutions = evidence.submoduleResolutions ?? []

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    expect(resolutions).toHaveLength(2)
    expect(resolutions.map(({ path }) => path)).toEqual(["dep", "dep"])
    const final = resolutions.at(-1)
    if (final === undefined) throw new Error("missing final submodule resolution")
    expect(await git(fixture.repo, ["ls-tree", "main", "dep"])).toContain(final.sha)
  }, 30_000)

  it("refuses a concurrent gitmodules origin change before publishing a composition", async () => {
    const fixture = await divergentSubmoduleRepository("clean")
    const unavailableOrigin = join(fixture.repo, "..", "replacement-module.git")
    await git(fixture.repo, ["switch", "-q", "issue/feature"])
    await git(fixture.repo, ["config", "-f", ".gitmodules", "submodule.dep.url", unavailableOrigin])
    await git(fixture.repo, ["add", ".gitmodules"])
    await git(fixture.repo, ["commit", "-qm", "change dependency origin"])
    const changedFeatureSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])
    await git(fixture.repo, ["-c", "protocol.file.allow=always", "submodule", "update", "-q"])

    await using process = createProcess()
    await using app = await checkedQueue(process, fixture.repo, ["true"], { env: authoredGitlinksEnv })
    await app.bays.submit({ branch: "issue/feature", headSha: changedFeatureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "candidate-conflict", message: expect.stringContaining(".gitmodules") },
    })
    expect(await git(fixture.repo, ["rev-parse", "main"])).toBe(fixture.rootCurrentSha)
    expect(await git(fixture.module, ["for-each-ref", "--format=%(refname)", "refs/yrd/compositions"])).toBe("")
  }, 20_000)

  it("preserves reviewed submodule blobs in a merge-only integration proof", async () => {
    const fixture = await divergentSubmoduleRepository("clean")
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const merge = withMerge(
      gitMergeStep<PRShape>({ inject: { process }, repo: fixture.repo, env: authoredGitlinksEnv }),
      { revision: "git-merge-v1" },
    )
    const queue = withQueue({
      steps: [merge] as const,
      resolveBaseSha: (base) => queueBaseSha(fixture.repo, base),
    })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: fixture.featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const proof = IntegrationProofSchema.parse(run.integration)

    expect(run.status, run.error?.message).toBe("completed")
    expect(run.conclusion).toBe("success")
    expect(proof.submoduleResolutions).toEqual([
      {
        kind: "compose",
        path: "dep",
        sha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        ref: expect.stringMatching(/^refs\/yrd\/compositions\/[0-9a-f]{64}$/u),
        reviewedBlobs: [
          {
            path: "notes.md",
            oid: expect.stringMatching(/^[0-9a-f]{40}$/u),
            content: "top-current\nmiddle\nbottom-incoming\n",
          },
        ],
      },
    ])
    const resolution = proof.submoduleResolutions?.[0]
    if (resolution === undefined) throw new Error("missing durable submodule resolution")
    expect(await git(fixture.repo, ["ls-tree", "main", "dep"])).toContain(resolution.sha)
  }, 20_000)

  it("runs remote push hooks from the checked candidate tree and submodule pins", async () => {
    const { repo, remote, featureSha, moduleSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })

    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand('git submodule update --init --recursive && test "$(cat dep/version.txt)" = candidate'),
      { env: { ...globalThis.process.env, YRD_ALLOW_AUTHORED_GITLINKS: "1" } },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "success", prs: [{ headSha: featureSha }] })
    expect(await git(remote, ["ls-tree", "main", "dep"])).toContain(moduleSha)
  })

  it("rejects a checked candidate that fails a hook even when the operator tree passes it", async () => {
    const { repo, remote, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "accepted",
      candidateVersion: "invalid",
      requiredVersion: "accepted",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, shellCommand("git submodule update --init --recursive"), {
      env: { ...globalThis.process.env, YRD_ALLOW_AUTHORED_GITLINKS: "1" },
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "merge-push-failed" } })
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
    const landing = await git(remote, ["rev-parse", "main"])
    const landedPaths = (await git(remote, ["ls-tree", "--name-only", landing])).split("\n")
    expect(landedPaths.filter((path) => path === "one.txt" || path === "two.txt")).toHaveLength(1)
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

  it("preserves remote evidence and lands its pinned candidate", async () => {
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
    await expectLanded(repo, checkpoint)
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
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(existsSync(join(repo, "feature.txt"))).toBe(false)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
  })

  it.each(["native-worktree", "native-ref", "native-remote", "configured"] as const)(
    "drains canceled or superseded authority at the %s merge side-effect boundary",
    async (landingMode) => {
      const { repo, feature: featureSha } = await repository("feature")
      const baseSha = await git(repo, ["rev-parse", "main"])
      await using process = createProcess()
      const checkInput = {
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      } satisfies StepExecution<PRShape>
      const checked = await gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] })(
        checkInput,
        { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal },
      )
      if (checked.status !== "completed" || checked.conclusion !== "success") throw new Error("check did not pass")
      if (landingMode === "native-remote") {
        const remote = join(repo, "..", "origin.git")
        await Bun.$`git init -q --bare ${remote}`
        await git(repo, ["remote", "add", "origin", remote])
        await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
      } else if (landingMode === "native-ref") {
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
            ((landingMode === "native-remote" &&
              request.argv[3] === "config" &&
              request.argv.includes("submodule.alternateLocation")) ||
              (landingMode !== "native-remote" &&
                request.argv[3] === "merge-base" &&
                request.argv[4] === "--is-ancestor" &&
                request.argv[5] === featureSha))
          ) {
            canceled.abort()
          }
          if (
            request.argv[0] === "git" &&
            ((landingMode === "native-worktree" && request.argv[3] === "merge" && request.argv[4] === "--ff-only") ||
              (landingMode === "native-ref" &&
                request.argv[3] === "update-ref" &&
                request.argv[4] === "refs/heads/main") ||
              (landingMode === "native-remote" && request.argv[3] === "push"))
          ) {
            mergeRuns += 1
          }
          return process.run(request)
        },
      }
      const merge =
        landingMode === "configured"
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
      const landedSha =
        landingMode === "native-remote"
          ? (await git(repo, ["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0]
          : await git(repo, ["rev-parse", "main"])
      expect(landedSha).toBe(baseSha)
    },
  )

  it("reconciles the authoritative landing after a delegated merge reports a post-push failure", async () => {
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
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const landing = await git(repo, ["rev-parse", "refs/remotes/origin/main"])
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "completed" || checkJob.conclusion !== "success") throw new Error("check did not pass")

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: landing, baseSha: landing },
    })
    expect(await git(repo, ["merge-base", "--is-ancestor", run.integration!.commit, "refs/remotes/origin/main"])).toBe(
      "",
    )
    expect(landing).not.toBe(GitCheckEvidenceSchema.parse(checkJob.output).candidateSha)
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      status: "integrated",
      integration: { commit: landing, baseSha: landing },
    })
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
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
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
    expect(prFacts(app.state().bays.prs.PR1)).toMatchObject({
      revision: 1,
      headSha: featureSha,
      status: "submitted",
    })
  })

  it("rolls back a configured root landing when its source Candidate ref disappears", async () => {
    const { repo, module, oldPinSha, sourceTipSha, rootBaseSha } = await restackSubmoduleRepository()
    const remote = join(repo, "..", "root-origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/source"])

    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep("check", gitCheckStep({ inject: { process }, repo, command: ["true"] }), {
      revision: "check-v1",
      output: GitCheckResultEvidenceSchema,
    })
    const merge = withMerge(
      configuredMergeStep<Checked>({
        inject: { process },
        repo,
        command: shellCommand(
          'git push origin "$YRD_CANDIDATE_SHA:refs/heads/main" && ' +
            'source_ref=$(git -C dep for-each-ref --format="%(refname)" refs/heads/yrd/candidates) && ' +
            'test -n "$source_ref" && git -C dep push origin ":$source_ref"',
        ),
      }),
      { revision: "delegated-merge-v1" },
    )
    const queue = withQueue({
      steps: [check, merge] as const,
      resolveBaseSha: (base) => queueBaseSha(repo, base),
    })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({
      branch: "issue/source",
      headSha: rootBaseSha,
      base: "main",
      baseSha: rootBaseSha,
      composition: {
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
      },
    })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "invalid-candidate" } })
    expect(await git(remote, ["rev-parse", "main"])).toBe(rootBaseSha)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(rootBaseSha)
    expect(await git(module, ["for-each-ref", "--format=%(refname)", "refs/heads/yrd/candidates"])).toBe("")
  })

  it("fails a delegated merge command that exits zero without landing the PR", async () => {
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
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    expect((await app.queue.run({ prs: ["PR1"] }, runtime))[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "merge-command-did-not-land" },
    })
  })
})

describe("configuredCommandStep — a timed-out command is a NAMED timeout failure (21012 S1)", () => {
  it("fails with <purpose>-timeout naming the bound, not a generic exit red", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-cmd-timeout-"))
    roots.push(cwd)
    await using process = createProcess({ cwd, killGraceMs: 500 })
    const runner = configuredCommandStep<PRShape>({
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
      } as unknown as StepExecution<PRShape>,
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
