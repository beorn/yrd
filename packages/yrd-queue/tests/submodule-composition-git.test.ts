/**
 * @failure Queue-native composition can publish an unreachable or unreviewed synthetic pin, or reject retryable store failures as content conflicts.
 * @level l1
 * @consumer @yrd/queue submodule composition runner
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, type ProcessRequest } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
import { executeQueueSubmoduleComposition } from "../src/submodule-composition-git.ts"
import { planQueueSubmoduleComposition, type QueueSubmoduleCompositionPlan } from "../src/submodule-composition.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type Repository = Readonly<{
  root: string
  store: string
  origin: string
  baseSha: string
  currentSha: string
  incomingSha: string
}>

async function git(
  repo: string,
  args: readonly string[],
  allowFailure = false,
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (!allowFailure && code !== 0) throw new Error(stderr || stdout)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function repository(kind: "clean" | "conflict" | "unrelated" = "clean"): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), "yrd-submodule-composition-"))
  roots.push(root)
  const store = join(root, "store")
  const origin = join(root, "origin.git")
  await Bun.$`git init -q -b main ${store}`
  await git(store, ["config", "user.name", "Yrd Test"])
  await git(store, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(store, "notes.md"), "top\nmiddle\nbottom\n")
  await git(store, ["add", "notes.md"])
  await git(store, ["commit", "-qm", "base"])
  const baseSha = (await git(store, ["rev-parse", "HEAD"])).stdout

  await git(store, ["switch", "-qc", "current"])
  await writeFile(
    join(store, "notes.md"),
    kind === "conflict" ? "top\ncurrent\nbottom\n" : "top-current\nmiddle\nbottom\n",
  )
  await git(store, ["commit", "-qam", "current"])
  const currentSha = (await git(store, ["rev-parse", "HEAD"])).stdout

  if (kind === "unrelated") {
    await git(store, ["switch", "--orphan", "incoming"])
    await git(store, ["rm", "-qrf", "."], true)
  } else {
    await git(store, ["switch", "-qc", "incoming", baseSha])
  }
  await writeFile(
    join(store, "notes.md"),
    kind === "conflict" ? "top\nincoming\nbottom\n" : "top\nmiddle\nbottom-incoming\n",
  )
  await git(store, ["add", "notes.md"])
  await git(store, ["commit", "-qm", "incoming"])
  const incomingSha = (await git(store, ["rev-parse", "HEAD"])).stdout

  await Bun.$`git init -q --bare ${origin}`
  await git(store, ["remote", "add", "origin", origin])
  await git(store, ["push", "-q", "origin", "main", "current", "incoming"])
  return { root, store, origin, baseSha, currentSha, incomingSha }
}

function compositionPlan(repo: Repository): Extract<QueueSubmoduleCompositionPlan, { status: "planned" }> {
  const plan = planQueueSubmoduleComposition([
    {
      path: "vendor/dependency",
      origin: repo.origin,
      stages: [
        { stage: 1, mode: "160000", oid: repo.baseSha },
        { stage: 2, mode: "160000", oid: repo.currentSha },
        { stage: 3, mode: "160000", oid: repo.incomingSha },
      ],
    },
  ])
  if (plan.status !== "planned") throw new Error(plan.message)
  return plan
}

function afterInitialRemoteRead(
  process: ReturnType<typeof createProcess>,
  ref: string,
  race: () => Promise<void>,
): Readonly<{ process: Pick<ReturnType<typeof createProcess>, "run">; raced(): boolean }> {
  let complete = false
  return {
    process: {
      async run(request: ProcessRequest) {
        const result = await process.run(request)
        if (!complete && request.argv.includes("ls-remote") && request.argv.at(-1) === ref) {
          complete = true
          await race()
        }
        return result
      },
    },
    raced: () => complete,
  }
}

describe("queue-native submodule composition Git runner", () => {
  it("publishes one deterministic two-parent commit and surfaces the composed Markdown", async () => {
    const repo = await repository()
    const plan = compositionPlan(repo)
    await using process = createProcess()
    const requests: ProcessRequest[] = []
    const bounded = {
      run(request: ProcessRequest) {
        requests.push(request)
        return process.run(request)
      },
    }

    const first = await executeQueueSubmoduleComposition(plan, {
      inject: { process: bounded, storeForOrigin: () => repo.store },
    })
    const second = await executeQueueSubmoduleComposition(plan, {
      inject: { process: bounded, storeForOrigin: () => repo.store },
    })

    expect(first).toEqual(second)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.timeoutMs === 30_000)).toBe(true)
    expect(first).toMatchObject({
      status: "composed",
      resolutions: [
        {
          kind: "compose",
          path: "vendor/dependency",
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
      ],
    })
    if (first.status !== "composed" || first.resolutions[0]?.kind !== "compose") {
      throw new Error("expected a composed resolution")
    }
    const composed = first.resolutions[0]
    expect((await git(repo.origin, ["rev-parse", composed.ref])).stdout).toBe(composed.sha)
    expect((await git(repo.store, ["show", "-s", "--format=%P", composed.sha])).stdout).toBe(
      `${repo.currentSha} ${repo.incomingSha}`,
    )
    expect((await git(repo.store, ["show", "-s", "--format=%an <%ae>", composed.sha])).stdout).toBe(
      "Yrd Queue <queue@yrd.dev>",
    )
    expect((await git(repo.store, ["show", `${composed.sha}:notes.md`])).stdout).toBe(
      "top-current\nmiddle\nbottom-incoming",
    )
    expect((await git(repo.store, ["show", "-s", "--format=%B", composed.sha])).stdout).toContain(
      `Yrd-Composition-Base: ${repo.baseSha}`,
    )
    expect((await git(repo.store, ["show", "-s", "--format=%B", composed.sha])).stdout).toContain(
      `Yrd-Composition-Parents: ${repo.currentSha} ${repo.incomingSha}`,
    )
  })

  it("refuses a planned base that is not an ancestor of both parents", async () => {
    const repo = await repository()
    const plan = compositionPlan(repo)
    const resolution = plan.resolutions[0]
    if (resolution?.kind !== "compose") throw new Error("expected a composition resolution")
    const invalid = {
      ...plan,
      resolutions: [{ ...resolution, baseSha: repo.currentSha }],
    } satisfies Extract<QueueSubmoduleCompositionPlan, { status: "planned" }>
    await using process = createProcess()

    const result = await executeQueueSubmoduleComposition(invalid, {
      inject: { process, storeForOrigin: () => repo.store },
    })

    expect(result).toMatchObject({
      status: "refused",
      code: "submodule-composition-unavailable",
      path: "vendor/dependency",
      message: expect.stringContaining("planned merge base"),
    })
    expect((await git(repo.origin, ["show-ref", "--verify", "--quiet", resolution.ref], true)).code).toBe(1)
  })

  it("refuses a real content conflict without publishing a composition ref", async () => {
    const repo = await repository("conflict")
    const plan = compositionPlan(repo)
    await using process = createProcess()

    const result = await executeQueueSubmoduleComposition(plan, {
      inject: { process, storeForOrigin: () => repo.store },
    })

    expect(result).toMatchObject({
      status: "refused",
      code: "submodule-composition-conflict",
      path: "vendor/dependency",
    })
    const ref = plan.resolutions[0]?.kind === "compose" ? plan.resolutions[0].ref : "missing"
    expect((await git(repo.origin, ["show-ref", "--verify", "--quiet", ref], true)).code).toBe(1)
  })

  it("never moves an existing composition ref", async () => {
    const repo = await repository()
    const plan = compositionPlan(repo)
    const resolution = plan.resolutions[0]
    if (resolution?.kind !== "compose") throw new Error("expected a composition resolution")
    await git(repo.store, ["push", "-q", "origin", `${repo.baseSha}:${resolution.ref}`])
    await using process = createProcess()

    const result = await executeQueueSubmoduleComposition(plan, {
      inject: { process, storeForOrigin: () => repo.store },
    })

    expect(result).toMatchObject({
      status: "refused",
      code: "submodule-composition-unavailable",
      path: "vendor/dependency",
      message: expect.stringContaining("will not be moved"),
    })
    expect((await git(repo.origin, ["rev-parse", resolution.ref])).stdout).toBe(repo.baseSha)
  })

  it("atomically refuses a different ref created after the initial remote read", async () => {
    const repo = await repository()
    const plan = compositionPlan(repo)
    const resolution = plan.resolutions[0]
    if (resolution?.kind !== "compose") throw new Error("expected a composition resolution")
    await using process = createProcess()
    const interleaving = afterInitialRemoteRead(process, resolution.ref, async () => {
      await git(repo.store, ["push", "-q", "origin", `${repo.baseSha}:${resolution.ref}`])
    })

    const result = await executeQueueSubmoduleComposition(plan, {
      inject: { process: interleaving.process, storeForOrigin: () => repo.store },
    })

    expect(interleaving.raced()).toBe(true)
    expect(result).toMatchObject({
      status: "refused",
      code: "submodule-composition-unavailable",
      path: "vendor/dependency",
      message: expect.stringContaining("will not be moved"),
    })
    expect((await git(repo.origin, ["rev-parse", resolution.ref])).stdout).toBe(repo.baseSha)
  })

  it("accepts a concurrent creator that publishes the same deterministic SHA", async () => {
    const repo = await repository()
    const plan = compositionPlan(repo)
    const resolution = plan.resolutions[0]
    if (resolution?.kind !== "compose") throw new Error("expected a composition resolution")
    await using process = createProcess()
    const initial = await executeQueueSubmoduleComposition(plan, {
      inject: { process, storeForOrigin: () => repo.store },
    })
    if (initial.status !== "composed" || initial.resolutions[0]?.kind !== "compose") {
      throw new Error("expected a composed resolution")
    }
    const sha = initial.resolutions[0].sha
    await git(repo.origin, ["update-ref", "-d", resolution.ref])
    const interleaving = afterInitialRemoteRead(process, resolution.ref, async () => {
      await git(repo.store, ["push", "-q", "origin", `${sha}:${resolution.ref}`])
    })

    const result = await executeQueueSubmoduleComposition(plan, {
      inject: { process: interleaving.process, storeForOrigin: () => repo.store },
    })

    expect(interleaving.raced()).toBe(true)
    expect(result).toEqual(initial)
    expect((await git(repo.origin, ["rev-parse", resolution.ref])).stdout).toBe(sha)
  })

  it("refuses a shallow store as retryable composition unavailability", async () => {
    const repo = await repository()
    const shallow = join(repo.root, "shallow.git")
    await Bun.$`git clone -q --bare --depth=1 ${`file://${repo.origin}`} ${shallow}`
    await using process = createProcess()

    const result = await executeQueueSubmoduleComposition(compositionPlan(repo), {
      inject: { process, storeForOrigin: () => shallow },
    })

    expect(result).toMatchObject({
      status: "refused",
      code: "submodule-composition-unavailable",
      path: "vendor/dependency",
      message: expect.stringContaining("shallow"),
    })
  })

  it("refuses histories without a merge base as retryable composition unavailability", async () => {
    const repo = await repository("unrelated")
    await using process = createProcess()

    const result = await executeQueueSubmoduleComposition(compositionPlan(repo), {
      inject: { process, storeForOrigin: () => repo.store },
    })

    expect(result).toMatchObject({
      status: "refused",
      code: "submodule-composition-unavailable",
      path: "vendor/dependency",
      message: expect.stringContaining("merge base"),
    })
  })
})
