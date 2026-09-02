/**
 * @failure A required check whose child ran out of quota or space — `fatal:
 * unable to write loose object file: Disk quota exceeded` — exits non-zero,
 * and the command runner files it as `<purpose>-failed`: the author's
 * disposition, which retired PR3159's standing submit fact on 2026-09-01
 * (22:24 PDT, `/tmp` a quota'd tmpfs) for content that was never at fault.
 * Operator ruling: an ENOSPC/EDQUOT is "yrd is broken, fix yrd", never "PR
 * broken, send back". The driver's own artifact writes had the same hole: an
 * EDQUOT there escaped as a thrown, untyped error the job layer files as
 * `runner-error`.
 * @level l2
 * @consumer @yrd/queue configuredCommandStep, @yrd/cli refusal rendering
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { configuredCommandStep, type ChangeShape } from "../src/index.ts"
import { CHECK_STORAGE_EXHAUSTED } from "../src/scratch-storage.ts"
import type { Process, ProcessRequest, ProcessResult } from "@yrd/process"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-check-storage-"))
  roots.push(root)
  return root
}

/**
 * The lines PR3159's `affected-tests` output.log carried, elided path
 * segments filled in: git's stderr from the check's child, the check's own
 * evidence line, and Node's errno from the driver's last write.
 */
const PR3159_LINES = [
  "fatal: unable to write loose object file: Disk quota exceeded",
  "error: copy-fd: write returned: Disk quota exceeded",
  "fatal: cannot copy '/nix/store/9k2b7q1x-git-2.45.2/share/git-core/templates/info/exclude' to " +
    "'/tmp/km-vitest-3001/run-0ab3e2db-7c1e/lint-bead-hygiene-delta-72eZkv/.git/info/exclude'",
  "error: copy-fd: write returned: Disk quota exceeded",
  "affected evidence kept: /tmp/tent-affected-fe8520e8ea72/attempt-YgSeTT — the check did not pass; inspect it, then remove it",
  "EDQUOT: unknown error, write",
]
const PR3159_FAILING_PATH = "/tmp/km-vitest-3001/run-0ab3e2db-7c1e/lint-bead-hygiene-delta-72eZkv/.git/info/exclude"

/** A check that exits `exitCode` having printed `output` — the only facts the verdict below has to work from. */
function checkPrinting(output: string, exitCode: number): Process {
  return {
    run: async (_request: ProcessRequest): Promise<ProcessResult> => ({
      exitCode,
      signal: null,
      stdout: "",
      stderr: output,
      durationMs: 1,
      timedOut: false,
    }),
  } as unknown as Process
}

/** A check whose process could not even be run: the runner itself threw `cause`. */
function checkThrowing(cause: unknown): Process {
  return {
    run: async (_request: ProcessRequest): Promise<ProcessResult> => {
      throw cause
    },
  } as unknown as Process
}

const execution = {
  run: "R3159",
  step: "affected-tests",
  index: 0,
  prs: [
    {
      id: "PR3159",
      changeId: `I${"c0ffee12".repeat(5)}`,
      branch: "task/affected",
      base: "main",
      revision: 1,
      headSha: "a".repeat(40),
    },
  ],
  shape: { results: {} },
} as const

async function judge(process: Process, purpose = "affected-tests") {
  const cwd = await workspace()
  const artifactRoot = join(cwd, "artifacts")
  const step = configuredCommandStep<ChangeShape>({
    inject: { process },
    command: ["false"],
    cwd,
    artifactRoot,
    purpose,
  })
  const outcome = await step(
    { ...execution, step: purpose },
    { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
  )
  return { outcome, terminal: join(artifactRoot, execution.run, `0-${purpose}`, "attempt-1", "terminal.json") }
}

function failureOf(outcome: Awaited<ReturnType<typeof judge>>["outcome"]) {
  if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("expected a failure outcome")
  return outcome
}

describe("a check whose output says the filesystem ran out is an infrastructure failure, never the author's", () => {
  it("files the PR3159 output under check-storage-exhausted, naming the quota, the path, the line and the cure", async () => {
    const { outcome } = await judge(checkPrinting(PR3159_LINES.join("\n"), 1))
    const failure = failureOf(outcome)

    expect(failure.error.code).toBe(CHECK_STORAGE_EXHAUSTED)
    expect(failure.error.code).not.toBe("affected-tests-failed")
    const { message } = failure.error
    expect(message).toContain("affected-tests")
    expect(message).toContain("ran out of quota")
    expect(message).toContain(PR3159_FAILING_PATH)
    expect(message).toContain("fatal: unable to write loose object file: Disk quota exceeded")
    expect(message).toContain(`free the filesystem backing ${PR3159_FAILING_PATH}`)
    expect(message).toContain("`yrd queue run` (or the service's next queue run) takes this change again")
    expect(message).toContain("nothing about the submitted content is at fault")
    expect(message).toMatch(/full output: .*output\.log$/u)
  })

  it("carries the storage-exhaustion evidence beside the command evidence, with the failing path", async () => {
    const { outcome } = await judge(checkPrinting(PR3159_LINES.join("\n"), 1))
    const failure = failureOf(outcome)
    const evidence = failure.error.evidence as Readonly<{ kind?: string; failingPath?: string; line?: string }>

    expect(evidence.kind).toBe("storage-exhaustion")
    expect(evidence.failingPath).toBe(PR3159_FAILING_PATH)
    expect(evidence.line).toBe("fatal: unable to write loose object file: Disk quota exceeded")
    // The command's own durable evidence — artifacts, exit code — survives as the output payload.
    expect(failure.output).toMatchObject({ exitCode: 1, artifacts: [{ name: "stderr" }] })
  })

  // A `fatal:` line the FILESYSTEM wrote matches the judged-line shapes, and a
  // judged `check-failed` is structurally permanent (queue.ts
  // `structurallyPermanentAdmissionRefusal`). The filesystem's statement is not
  // the check's judgement of the content, so the record must not say it is.
  it("records NO judged failure — in the evidence and in terminal.json alike", async () => {
    const { outcome, terminal } = await judge(checkPrinting(PR3159_LINES.join("\n"), 1))
    const failure = failureOf(outcome)

    expect(failure.output).not.toHaveProperty("judgedFailure")
    const record = JSON.parse(await readFile(terminal, "utf8")) as Readonly<{ status: string; judgedFailure?: true }>
    expect(record.status).toBe("failure")
    expect(record).not.toHaveProperty("judgedFailure")
  })

  it("names a space exhaustion as such when the device itself is full (R2233 shape)", async () => {
    const { outcome } = await judge(
      checkPrinting(
        "error: unable to create file hub/silvery/research/cmux.md: No space left on device\nfatal: could not detach HEAD",
        128,
      ),
    )
    const failure = failureOf(outcome)

    expect(failure.error.code).toBe(CHECK_STORAGE_EXHAUSTED)
    expect(failure.error.message).toContain("ran out of space")
    // No path was named, so none is claimed; the cure still names what to free.
    expect(failure.error.message).toContain("free the filesystem backing the check's scratch")
  })

  it("leaves a genuine red alone: a vitest row that merely NAMES the errno is the author's verdict", async () => {
    const { outcome } = await judge(
      checkPrinting(
        [
          " FAIL  packages/yrd-queue/tests/scratch-storage.test.ts > isStorageExhaustion — ENOSPC is not a merge conflict > classifies a Node filesystem ENOSPC error by its code",
          "AssertionError: expected false to be true",
          " Test Files  1 failed (1)",
        ].join("\n"),
        1,
      ),
    )
    const failure = failureOf(outcome)

    expect(failure.error.code).toBe("affected-tests-failed")
    expect(failure.output).toMatchObject({ judgedFailure: true })
  })

  it("leaves a green alone: a check that exited 0 stated its own verdict, whatever its output mentioned", async () => {
    const { outcome } = await judge(checkPrinting("warning: EDQUOT: unknown error, write (ignored)\nok", 0))

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
  })
})

describe("the driver's own writes: an EDQUOT the runner itself hits is the same infrastructure failure", () => {
  it("classifies a thrown EDQUOT from the process runner instead of escaping as runner-error", async () => {
    const cause = Object.assign(new Error("EDQUOT: unknown error, write"), { code: "EDQUOT", syscall: "write" })
    const { outcome } = await judge(checkThrowing(cause))
    const failure = failureOf(outcome)

    expect(failure.error.code).toBe(CHECK_STORAGE_EXHAUSTED)
    expect(failure.error.message).toContain("affected-tests")
    expect(failure.error.message).toContain("yrd could not write its own run artifacts")
    expect(failure.error.message).toContain("EDQUOT: unknown error, write")
    expect(failure.error.message).toContain("nothing about the submitted content is at fault")
    expect((failure.error.evidence as Readonly<{ kind?: string }>).kind).toBe("storage-exhaustion")
  })

  it("still lets every other thrown cause escape — the classification is not a catch-all", async () => {
    const cause = Object.assign(new Error("spawn false ENOENT"), { code: "ENOENT" })

    await expect(judge(checkThrowing(cause))).rejects.toBe(cause)
  })
})
