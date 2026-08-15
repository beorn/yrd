/**
 * @failure A check voided only by the queue's own base motion forces a full recut, so batch depth collapses to one.
 * @level l2
 * @consumer @yrd/queue carry-forward
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess } from "@yrd/process"
import { createLogger } from "loggily"
import * as z from "zod"
import {
  DEFAULT_CARRY_FORWARD_POLICY,
  GitCheckResultEvidenceSchema,
  gitCheckStep,
  gitMergeStep,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type CarryForwardPolicy,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"

const roots: string[] = []
const runtime = { runner: "local", leaseMs: 60_000 }

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }
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

async function repository(name: string): Promise<{ repo: string; feature: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-carry-forward-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  await git(repo, ["switch", "-qc", `issue/${name}`])
  await writeFile(join(repo, `${name}.txt`), `${name}\n`)
  await git(repo, ["add", `${name}.txt`])
  await git(repo, ["commit", "-qm", name])
  const feature = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, feature }
}

const unusedWorkspace: BayWorkspace = {
  revision: "unused-workspace-v1",
  provision: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
  checkpoint: () => ({ status: "completed", conclusion: "failure", error: { code: "unused", message: "not used" } }),
  deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
}

type Checked = AddStepResult<PRShape, "check", z.infer<typeof GitCheckResultEvidenceSchema>>
const MovedSchema = z.object({ moved: z.literal(true) }).strict()
type Moved = AddStepResult<Checked, "move-base", z.infer<typeof MovedSchema>>

/** One run whose base moves BETWEEN the check step and the merge step: the
 * exact shape of the queue's own landings voiding a peer's still-good verdict.
 * `motionPath` is what the base motion touches — disjoint from the candidate's
 * `feature.txt` payload, or overlapping it. */
async function runWithBaseMotion(
  motionPath: string,
  policy: Partial<CarryForwardPolicy> = {},
  random: () => number = () => 0.99,
) {
  const { repo, feature: featureSha } = await repository("feature")
  const process = createProcess()
  const bayJobs = createBayJobDefs(unusedWorkspace)
  const check = withStep(
    "check",
    gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
    { revision: "check-v1", output: GitCheckResultEvidenceSchema },
  )
  const move = withStep(
    "move-base",
    async (_input: StepExecution<Checked>) => {
      await writeFile(join(repo, motionPath), "moved after check\n")
      await git(repo, ["add", motionPath])
      await git(repo, ["commit", "-qm", `move base after check (${motionPath})`])
      return { status: "completed", conclusion: "success" as const, output: { moved: true as const } }
    },
    { revision: "move-base-v1", output: MovedSchema },
  )
  const merge = withMerge(
    gitMergeStep<Moved>({
      inject: { process },
      repo,
      carryForward: { ...DEFAULT_CARRY_FORWARD_POLICY, shadowSampleRate: 0, ...policy },
      random,
    }),
    { revision: "git-merge-v1" },
  )
  const queue = withQueue({
    steps: [check, move, merge] as const,
    resolveBaseSha: (base) => queueBaseSha(repo, base),
  })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  const app = await createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
  })
  await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
  const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
  return { app, process, repo, run }
}

describe("carry-forward", () => {
  it("carries a check across a disjoint base motion instead of refusing into a recut", async () => {
    const { app, process, repo, run } = await runWithBaseMotion("base-moved.txt")
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    // The payload landed without the check ever running a second time.
    expect(existsSync(join(repo, "feature.txt"))).toBe(true)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
    // The verdict is recorded as carried, naming BOTH bases.
    expect(run.integration?.carriedForward).toMatchObject({
      fromBaseSha: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      toBaseSha: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
    })
    expect(run.integration?.carriedForward?.fromBaseSha).not.toBe(run.integration?.carriedForward?.toBaseSha)
  })

  it("still refuses into a recut when the base motion overlaps the candidate payload", async () => {
    const { app, process, repo, run } = await runWithBaseMotion("feature.txt")
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.message).toContain("feature.txt")
    expect(existsSync(join(repo, "feature.txt"))).toBe(true)
  })

  it("names the leg that refused, never a bare staleness", async () => {
    const { app, process, run } = await runWithBaseMotion("bun.lock")
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.message).toContain("carry-forward refused (build-affecting-motion)")
    expect(run.error?.message).toContain("bun.lock")
  })

  it("declines the carry on a shadow-recut sample so a fresh check re-proves the payload", async () => {
    const { app, process, run } = await runWithBaseMotion("base-moved.txt", { shadowSampleRate: 1 }, () => 0)
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.message).toContain("shadow-recut sample")
  })

  it("refuses through the persisted kill switch even on a disjoint motion", async () => {
    const { app, process, run } = await runWithBaseMotion("base-moved.txt", {
      disabledBy: { reason: "a shadow recut diverged", at: "2026-08-14T00:00:00.000Z" },
    })
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.message).toContain("carry-forward refused (kill-switch)")
  })

  it("refuses when carry-forward is disabled by configuration", async () => {
    const { app, process, run } = await runWithBaseMotion("base-moved.txt", { enabled: false })
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.message).toContain("carry-forward refused (disabled)")
  })
})
