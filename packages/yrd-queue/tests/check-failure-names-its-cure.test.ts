/**
 * @failure A failing required check refuses with `<name> command exited 1` and
 * nothing else: not the line that judged it, not the artifact holding that
 * line. PR2695/2696/2697 (affected-tests) and PR2699 (a pre-submit guard) all
 * skipped this way on 2026-08-29 — the two named tests and the guard's own
 * refusal sentence existed, in the attempt directory, and the refusal pointed
 * at neither.
 * @level l2
 * @consumer @yrd/queue configuredCommandStep, @yrd/cli refusal rendering
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { configuredCommandStep, type ChangeShape } from "../src/index.ts"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-check-cure-"))
  roots.push(root)
  return root
}

/** A check that exits non-zero having printed `output` — the only fact the
 * refusal below has to work from. */
function checkPrinting(output: string, stream: "stdout" | "stderr" = "stdout"): Process {
  return {
    run: async (_request: ProcessRequest): Promise<ProcessResult> => ({
      exitCode: 1,
      signal: null,
      stdout: stream === "stdout" ? output : "",
      stderr: stream === "stderr" ? output : "",
      durationMs: 1,
      timedOut: false,
    }),
  } as unknown as Process
}

async function refuse(output: string, purpose: string, stream: "stdout" | "stderr" = "stdout") {
  const cwd = await workspace()
  const artifactRoot = join(cwd, "artifacts")
  const step = configuredCommandStep<ChangeShape>({
    inject: { process: checkPrinting(output, stream) },
    command: ["false"],
    cwd,
    artifactRoot,
    purpose,
  })
  return step(
    {
      run: "R1",
      step: purpose,
      index: 0,
      prs: [
        {
          id: "PR2695",
          changeId: `I${"c0ffee12".repeat(5)}`,
          branch: "task/affected",
          base: "main",
          revision: 1,
          headSha: "a".repeat(40),
        },
      ],
      shape: { results: {} },
    },
    { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
  )
}

describe("a failed check names the line that judged it and the file holding the rest", () => {
  it("names the failing test, not only the exit status (PR2695 specimen)", async () => {
    const outcome = await refuse(
      [
        " RUN  v4.1.10",
        " FAIL  packages/yrd-queue/tests/refusal-code-registry.test.ts > resolves every derived emitted code",
        "AssertionError: expected undefined to be defined",
        " Test Files  1 failed (1)",
      ].join("\n"),
      "affected-tests",
    )
    expect(outcome).toMatchObject({ status: "completed", conclusion: "failure" })
    const message = outcome.status === "completed" && outcome.conclusion === "failure" ? outcome.error.message : ""
    expect(message).toContain("affected-tests")
    expect(message).toContain("exited 1")
    // The whole defect: the judged line existed and the refusal did not carry it.
    expect(message).toContain("packages/yrd-queue/tests/refusal-code-registry.test.ts")
    // And the reader is told where the rest of it is.
    expect(message).toMatch(/output\.log/u)
  })

  it("names a guard's own refusal sentence (PR2699 specimen)", async () => {
    const outcome = await refuse(
      [
        "checking guarded verbs",
        "error: 'gitlink advance' is registered by yrd-cli but has no row in YRD_VERB_ACCESS",
      ].join("\n"),
      "pre-submit-guard",
      "stderr",
    )
    const message = outcome.status === "completed" && outcome.conclusion === "failure" ? outcome.error.message : ""
    expect(message).toContain("has no row in YRD_VERB_ACCESS")
  })

  it("fabricates no judgement when the check printed none — it still names the artifact to open", async () => {
    const outcome = await refuse("built 404 modules\ncompiled in 1.2s", "affected-tests")
    const message = outcome.status === "completed" && outcome.conclusion === "failure" ? outcome.error.message : ""
    expect(message).toContain("affected-tests command exited 1")
    expect(message).not.toContain("404")
    expect(message).toMatch(/output\.log/u)
  })

  it("keeps the refusal a headline: a runaway judged line cannot become the whole log", async () => {
    const outcome = await refuse(`error: ${"x".repeat(4000)}`, "affected-tests", "stderr")
    const message = outcome.status === "completed" && outcome.conclusion === "failure" ? outcome.error.message : ""
    expect(message.length).toBeLessThan(500)
  })
})
