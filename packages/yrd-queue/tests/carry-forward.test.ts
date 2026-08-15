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
 * `feature.txt` payload, or overlapping it.
 *
 * The returned `policy` is MUTABLE and read at run time, so a test can decline
 * the first merge by sample and let a later one carry — which is also what
 * proves the merge step reads its policy live rather than capturing it. */
async function runWithBaseMotion(
  motionPath: string,
  overrides: Partial<CarryForwardPolicy> = {},
  checkCommand: readonly string[] = ["test", "-f", "feature.txt"],
) {
  const policy: CarryForwardPolicy = { ...DEFAULT_CARRY_FORWARD_POLICY, shadowSampleRate: 0, ...overrides }
  // Mirrors the CLI host's carry-forward gate: the configured policy, plus the
  // PERSISTED kill switch read from live state. Steps are built before the app
  // exists, so the reader is filled in below.
  const gate: { read?: () => CarryForwardPolicy["disabledBy"] } = {}
  const mutable = { current: policy }
  const readPolicy = (): CarryForwardPolicy => {
    const disabledBy = gate.read?.()
    return { ...mutable.current, ...(disabledBy === undefined ? {} : { disabledBy }) }
  }
  const { repo, feature: featureSha } = await repository("feature")
  const process = createProcess()
  const bayJobs = createBayJobDefs(unusedWorkspace)
  const check = withStep("check", gitCheckStep({ inject: { process }, repo, command: checkCommand }), {
    revision: "check-v1",
    output: GitCheckResultEvidenceSchema,
  })
  let motions = 0
  const move = withStep(
    "move-base",
    async (_input: StepExecution<Checked>) => {
      // Distinct content per motion: an identical rewrite is not a commit, and
      // `git commit` refuses a clean tree — which would fail this step instead
      // of moving the base the test is about.
      motions += 1
      await writeFile(join(repo, motionPath), `moved after check ${motions}\n`)
      await git(repo, ["add", motionPath])
      await git(repo, ["commit", "-qm", `move base after check ${motions} (${motionPath})`])
      return { status: "completed", conclusion: "success" as const, output: { moved: true as const } }
    },
    { revision: "move-base-v1", output: MovedSchema },
  )
  const merge = withMerge(gitMergeStep<Moved>({ inject: { process }, repo, carryForward: readPolicy }), {
    revision: "git-merge-v1",
  })
  const queue = withQueue({
    steps: [check, move, merge] as const,
    resolveBaseSha: (base) => queueBaseSha(repo, base),
  })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  const app = await createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]) },
  })
  gate.read = () => {
    const disabled = app.state().queues.carryForwardDisabledBy
    return disabled === undefined ? undefined : { reason: disabled.reason, at: disabled.at, run: disabled.run }
  }
  await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
  const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
  const setPolicy = (next: Partial<CarryForwardPolicy>) => {
    mutable.current = { ...mutable.current, ...next }
  }
  return { app, process, repo, run, setPolicy, readPolicy, again: () => app.queue.run({ prs: ["PR1"] }, runtime) }
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
    const { app, process, run } = await runWithBaseMotion("base-moved.txt", { shadowSampleRate: 1 })
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

  // THE COMPARATOR. A sample declines the carry, which re-queues the member and
  // forces a real recut at the new base. If that recut FAILS, the verdict that
  // would have been carried was wrong — retire the path.
  //
  // A carried verdict is always "passed" (a failed check never reaches merge),
  // so "fresh check fails after a sample decline" IS the divergence.
  it("disables carry-forward when the forced recut disagrees with the carried verdict", async () => {
    // The check forbids poison.txt. It passes at base A, and the payload never
    // touches it — so the predicate WOULD have carried the verdict across a
    // motion that lands poison.txt. That is exactly the wrong answer the shadow
    // recut exists to catch.
    const { app, process, repo, run, setPolicy, readPolicy, again } = await runWithBaseMotion(
      "base-moved.txt",
      { shadowSampleRate: 1 },
      ["test", "!", "-f", "poison.txt"],
    )
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.evidence).toMatchObject({ kind: "carry-forward-shadow-sample", carriedVerdict: "passed" })
    expect(app.state().queues.carryForwardDisabledBy).toBeUndefined()

    await writeFile(join(repo, "poison.txt"), "breaks the check\n")
    await git(repo, ["add", "poison.txt"])
    await git(repo, ["commit", "-qm", "land something the carried verdict never saw"])
    setPolicy({ shadowSampleRate: 0 })

    const second = (await again())[0]!
    expect(second).toMatchObject({ status: "completed", conclusion: "failure" })

    const disabled = app.state().queues.carryForwardDisabledBy
    expect(disabled).toMatchObject({ carriedVerdict: "passed", freshVerdict: "failed", pr: "PR1" })
    expect(disabled?.reason).toContain("passed")
    expect(disabled?.reason).toContain("failed")
    expect(disabled?.fromBaseSha).not.toBe(disabled?.toBaseSha)

    // The loop is closed end to end: what the merge step reads at RUN time now
    // carries the persisted switch...
    expect(readPolicy().disabledBy).toMatchObject({ run: "R2" })

    // ...and the next carry-forward attempt refuses naming it. Getting there
    // needs the poison gone (so a check can pass again) and a new revision (a
    // failed required check blocks the member until one is pushed).
    await rm(join(repo, "poison.txt"))
    await git(repo, ["add", "poison.txt"])
    await git(repo, ["commit", "-qm", "remove the poison"])
    await git(repo, ["switch", "-q", "issue/feature"])
    await writeFile(join(repo, "feature.txt"), "feature v2\n")
    await git(repo, ["commit", "-qam", "feature v2"])
    const nextHead = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await app.bays.intake({ branch: "issue/feature", headSha: nextHead, base: "main" })
    await app.bays.submit({ pr: "PR1" })

    const third = (await again())[0]!
    expect(third).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(third.error?.message).toContain("carry-forward refused (kill-switch)")

    // And it is LOUD on the audit banner an operator actually reads.
    const finding = app.queue.audit().findings.find((entry) => entry.code === "carry-forward-disabled")
    expect(finding?.message).toContain("passed")
    expect(finding?.message).toContain("failed")
    expect(finding?.message).toContain("Every check now recuts")
  })

  it("keeps carry-forward live when the forced recut agrees with the carried verdict", async () => {
    const { app, process, run, setPolicy, again } = await runWithBaseMotion("base-moved.txt", {
      shadowSampleRate: 1,
    })
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })

    // Nothing broke the payload, so the forced recut agrees and the path lives.
    setPolicy({ shadowSampleRate: 0 })
    const second = (await again())[0]!
    expect(second).toMatchObject({ status: "completed", conclusion: "success" })
    // The second run carried the verdict rather than being sampled again.
    expect(second.integration?.carriedForward?.fromBaseSha).not.toBe(second.integration?.carriedForward?.toBaseSha)
    expect(app.state().queues.carryForwardDisabledBy).toBeUndefined()
  })

  it("refuses when carry-forward is disabled by configuration", async () => {
    const { app, process, run } = await runWithBaseMotion("base-moved.txt", { enabled: false })
    await using _process = process
    await using _app = app

    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "stale-check" } })
    expect(run.error?.message).toContain("carry-forward refused (disabled)")
  })
})
