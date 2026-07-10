/**
 * @failure Held-out checks can evaluate a moved branch tip or lose the process evidence needed to trust a verdict.
 * @level l2
 * @consumer @yrd/contest held-out evaluator adapters
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  createHeldOutCommandEvaluator,
  type HeldOutCommandEvaluatorOptions,
  type EvaluatorProcessRequest,
  type EvaluatorProcessResult,
} from "../src/evaluator.ts"
import type { ContestEvaluatorInput, EffectAdapterContext } from "../src/types.ts"

const PINNED_SHA = "a".repeat(40)
const MOVED_SHA = "b".repeat(40)
const roots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

function input(): ContestEvaluatorInput {
  return {
    contest: "C1",
    attempt: "A1",
    task: {
      ref: { source: "km", id: "@yrd/core/21012; $(touch /tmp/yrd-evaluator-injection)" },
      title: "Finish Yrd; $(touch /tmp/yrd-evaluator-title)",
    },
    competitor: { id: "codex", model: "gpt-5.6-sol", harness: "ag", config: {} },
    pin: {
      commit: PINNED_SHA,
      ref: "refs/yrd/attempts/C1/A1",
      branch: "yrd/contest/C1/A1",
      bay: "contest-C1-A1",
      baseSha: "c".repeat(40),
    },
    artifacts: [],
  }
}

const context: EffectAdapterContext = { id: "effect-C1-A1-tests", attempt: 2, executor: "worker-1" }

type FakeOptions = Readonly<{
  command?: EvaluatorProcessResult
  cleanup?: EvaluatorProcessResult
  refSha?: string
  checkoutSha?: string
}>

function fakeProcess(options: FakeOptions = {}): {
  requests: EvaluatorProcessRequest[]
  process(request: EvaluatorProcessRequest): Promise<EvaluatorProcessResult>
} {
  const requests: EvaluatorProcessRequest[] = []
  return {
    requests,
    async process(request) {
      requests.push(request)
      if (request.kind === "evaluator") {
        return options.command ?? { exitCode: 0, stdout: "27 checks passed\n", stderr: "" }
      }

      const args = request.argv.slice(1)
      if (args[0] === "worktree" && args[1] === "remove" && options.cleanup !== undefined) {
        return options.cleanup
      }
      if (args[0] === "rev-parse" && args.includes("refs/yrd/attempts/C1/A1^{commit}")) {
        return { exitCode: 0, stdout: `${options.refSha ?? PINNED_SHA}\n`, stderr: "" }
      }
      if (args[0] === "rev-parse" && args.includes("HEAD^{commit}")) {
        return { exitCode: 0, stdout: `${options.checkoutSha ?? PINNED_SHA}\n`, stderr: "" }
      }
      if (args[0] === "symbolic-ref") return { exitCode: 1, stdout: "", stderr: "" }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }
}

async function fixture(fakeOptions: FakeOptions = {}, options: Partial<HeldOutCommandEvaluatorOptions> = {}) {
  const bayPath = await temporaryRoot("yrd-evaluator-bay-")
  const artifactRoot = await temporaryRoot("yrd-evaluator-artifacts-")
  const resolvedBays: string[] = []
  const fake = fakeProcess(fakeOptions)
  const evaluator = createHeldOutCommandEvaluator({
    id: "held-out-tests",
    command: ["tests"],
    resolveBayPath: (bay) => {
      resolvedBays.push(bay)
      return bayPath
    },
    artifactRoot,
    process: fake.process,
    ...options,
  })
  return { artifactRoot, bayPath, evaluator, fake, resolvedBays }
}

async function artifactText(
  result: Awaited<ReturnType<ReturnType<typeof createHeldOutCommandEvaluator>["evaluate"]>>,
  kind: string,
): Promise<string> {
  if (result.status !== "passed") throw new Error(`expected passed evaluator effect, got ${result.status}`)
  const artifact = result.output.artifacts.find((candidate) => candidate.kind === kind)
  if (artifact === undefined) throw new Error(`missing ${kind} artifact`)
  return await readFile(fileURLToPath(artifact.uri), "utf8")
}

describe("held-out command evaluator", () => {
  it("verifies the write-once ref, evaluates a detached checkout at the pinned SHA, and records evidence", async () => {
    const times = [1_000, 1_125]
    const { bayPath, evaluator, fake, resolvedBays } = await fixture(
      {},
      {
        command: ["bun", "run", "test:focused", "--", "literal; $(touch /tmp/nope)"],
        now: () => times.shift() ?? 1_125,
      },
    )

    const result = await evaluator.evaluate(input(), context)

    expect(result).toMatchObject({ status: "passed", output: { verdict: "passed" } })
    expect(resolvedBays).toEqual(["contest-C1-A1"])
    const refCheck = fake.requests.find(
      (request) => request.kind === "git" && request.argv.includes("refs/yrd/attempts/C1/A1^{commit}"),
    )
    expect(refCheck?.argv).toEqual([
      "git",
      "rev-parse",
      "--verify",
      "--end-of-options",
      "refs/yrd/attempts/C1/A1^{commit}",
    ])
    const materialize = fake.requests.find(
      (request) => request.kind === "git" && request.argv.slice(0, 3).join(" ") === "git worktree add",
    )
    expect(materialize?.argv.at(-1)).toBe(PINNED_SHA)
    const command = fake.requests.find((request) => request.kind === "evaluator")
    expect(command?.argv).toEqual(["bun", "run", "test:focused", "--", "literal; $(touch /tmp/nope)"])
    expect(command?.cwd).not.toBe(bayPath)
    expect(command?.env).toMatchObject({
      YRD_CONTEST: "C1",
      YRD_ATTEMPT: "A1",
      YRD_PIN_COMMIT: PINNED_SHA,
      YRD_PIN_REF: "refs/yrd/attempts/C1/A1",
      YRD_TASK_ID: "@yrd/core/21012; $(touch /tmp/yrd-evaluator-injection)",
    })
    expect(await artifactText(result, "stdout")).toBe("27 checks passed\n")
    expect(await artifactText(result, "stderr")).toBe("")
    expect(JSON.parse(await artifactText(result, "evaluator-manifest"))).toMatchObject({
      schema: "yrd.contest.command-evaluator.v1",
      evaluator: { id: "held-out-tests", authority: "held-out" },
      pin: { commit: PINNED_SHA, ref: "refs/yrd/attempts/C1/A1" },
      checkout: { commit: PINNED_SHA, detached: true },
      process: { exitCode: 0, durationMs: 125 },
      result: { verdict: "passed" },
    })
  })

  it("returns a failed verdict, not an infrastructure error, with nonzero-exit evidence", async () => {
    const times = [500, 950]
    const { evaluator } = await fixture(
      { command: { exitCode: 17, stdout: "3 passed, 1 failed\n", stderr: "assertion failed\n" } },
      {
        command: ["test-runner", "--json=false"],
        now: () => times.shift() ?? 950,
      },
    )

    const result = await evaluator.evaluate(input(), context)

    expect(result).toMatchObject({
      status: "passed",
      output: {
        verdict: "failed",
        summary: "held-out-tests exited 17",
      },
    })
    expect(await artifactText(result, "stdout")).toBe("3 passed, 1 failed\n")
    expect(await artifactText(result, "stderr")).toBe("assertion failed\n")
    expect(JSON.parse(await artifactText(result, "evaluator-manifest"))).toMatchObject({
      process: { exitCode: 17, durationMs: 450 },
      result: { verdict: "failed" },
    })
  })

  it("writes produced stdout and stderr before reporting cleanup failure", async () => {
    const { artifactRoot, evaluator } = await fixture({
      command: { exitCode: 0, stdout: "durable stdout\n", stderr: "durable stderr\n" },
      cleanup: { exitCode: 1, stdout: "", stderr: "cleanup denied" },
    })

    const result = await evaluator.evaluate(input(), context)

    expect(result).toMatchObject({ status: "failed", error: { code: "pin-checkout-cleanup-failed" } })
    const stdout = await Array.fromAsync(new Bun.Glob("**/stdout.log").scan({ cwd: artifactRoot, absolute: true }))
    const stderr = await Array.fromAsync(new Bun.Glob("**/stderr.log").scan({ cwd: artifactRoot, absolute: true }))
    expect(stdout).toHaveLength(1)
    expect(stderr).toHaveLength(1)
    expect(await readFile(stdout[0]!, "utf8")).toBe("durable stdout\n")
    expect(await readFile(stderr[0]!, "utf8")).toBe("durable stderr\n")
  })

  it.each([
    ["moved attempt ref", { refSha: MOVED_SHA }, "pin-ref-mismatch"],
    ["wrong detached checkout", { checkoutSha: MOVED_SHA }, "pin-checkout-mismatch"],
  ])("fails closed before evaluation for a %s", async (_case, fakeOptions, code) => {
    const { evaluator, fake } = await fixture(fakeOptions)

    const result = await evaluator.evaluate(input(), context)

    expect(result).toMatchObject({ status: "failed", error: { code } })
    expect(fake.requests.some((request) => request.kind === "evaluator")).toBe(false)
  })

  it("turns an invalid environment provider into a typed effect failure", async () => {
    const { evaluator } = await fixture(
      {},
      {
        environment() {
          throw new Error("secret provider unavailable")
        },
      },
    )

    expect(await evaluator.evaluate(input(), context)).toMatchObject({
      status: "failed",
      error: { code: "evaluator-environment-invalid", message: "secret provider unavailable" },
    })
  })
})
