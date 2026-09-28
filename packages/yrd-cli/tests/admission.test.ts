/**
 * @failure A branch edits its own admission command and Yrd runs that edited copy instead of the target's policy.
 * @level l2 (real target Git worktree and process)
 * @consumer Yrd submit admission adapter.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn } from "@yrd/queue-core"
import { admissionVerdict, runAdmission } from "../src/admission.ts"
import type { ProcessResult } from "@yrd/process"

const base = tmpdir()
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("target-owned admission command", () => {
  it("distinguishes a refusal from a timeout and preserves the stdout cure", () => {
    const result = {
      exitCode: 1,
      signal: null,
      stdout: "Start 3: tick with evidence\n",
      stderr: "",
      timedOut: false,
      stalled: false,
      durationMs: 1,
    } as ProcessResult
    expect(admissionVerdict(result, "bun policy.ts", 100)).toEqual({
      kind: "refuse",
      reason: "Start 3: tick with evidence",
    })
    expect(admissionVerdict({ ...result, exitCode: 3 } as ProcessResult, "bun policy.ts", 100)).toEqual({
      kind: "warn",
      reason: "Start 3: tick with evidence",
    })
    expect(
      admissionVerdict({ ...result, exitCode: 3, signal: "SIGTERM" } as ProcessResult, "bun policy.ts", 100),
    ).toMatchObject({ kind: "cannot-judge", reason: expect.stringContaining("signal SIGTERM") })
    expect(
      admissionVerdict(
        { ...result, exitCode: 143, timedOut: true, stderr: "socket stalled" } as ProcessResult,
        "bun policy.ts",
        100,
      ),
    ).toMatchObject({
      kind: "cannot-judge",
      reason: expect.stringContaining("timed out after 100ms"),
    })
  })
  it("runs the target's script even when the submitted branch replaces it", async () => {
    const root = mkdtempSync(join(base, "target-"))
    roots.push(root)
    const repo = join(root, "repo")
    const git = gitIn(root)
    await git(["init", "--quiet", "--initial-branch=main", repo])
    const at = gitIn(repo)
    await at(["config", "user.email", "yrd@test.invalid"])
    await at(["config", "user.name", "yrd"])
    mkdirSync(join(repo, "tools"))
    writeFileSync(join(repo, "tools", "policy.sh"), "#!/bin/sh\ntest \"$YRD_ADMISSION_ISSUE\" = '@i/26273'\n")
    await at(["add", "tools/policy.sh"])
    await at(["commit", "--quiet", "-m", "target policy"])
    const targetHead = (await at(["rev-parse", "HEAD"])).trim()
    await at(["checkout", "--quiet", "-b", "task/try-to-disable"])
    writeFileSync(join(repo, "tools", "policy.sh"), "#!/bin/sh\nexit 1\n")
    await at(["add", "tools/policy.sh"])
    await at(["commit", "--quiet", "-m", "branch changes policy"])
    const head = (await at(["rev-parse", "HEAD"])).trim()
    expect(
      await runAdmission(
        at,
        repo,
        join(root, "workdir"),
        targetHead,
        { run: "sh tools/policy.sh", timeoutMs: 5000 },
        {
          issue: "@i/26273",
          branch: "task/try-to-disable",
          head,
        },
      ),
    ).toEqual({ kind: "admit" })
  })
})
