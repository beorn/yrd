/**
 * @failure The shaset-commit writer's contract changes without a test saying so — the wrapper
 *          had ZERO behavioural coverage while being "the ONE generated-root implementation
 *          shared by composed PRs, pin intents, and the materialize escape hatch".
 * @level l1
 * @consumer @i/10-merge-queue/b-derivation-sites — step (b)'s entry seam
 *
 * CHARACTERIZATION, not specification — the (a) pattern applied to (b)'s seam. Every
 * assertion pins what `synthesizeGitlinkWrapper` does TODAY, so the (b) build changes this
 * file DELIBERATELY, in the same commit as the mechanism. The one marked case is the flip
 * target: the single-update provisioner refusal is exactly what the provisioner lift removes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { synthesizeGitlinkWrapper } from "../src/command.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function sh(repo: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Yrd Test",
      GIT_AUTHOR_EMAIL: "yrd@example.invalid",
      GIT_COMMITTER_NAME: "Yrd Test",
      GIT_COMMITTER_EMAIL: "yrd@example.invalid",
    },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** The two members the wrapper actually uses, over a real repository. */
function gitAdapter() {
  return {
    async run(repo: string, args: readonly string[], _allowFailure?: boolean) {
      const result = await sh(repo, args)
      // The full GitResult shape: vitest does not typecheck, and the (a) fixture
      // already paid for an under-filled return type once — tsc is the gate here.
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: 0,
        signal: null,
        timedOut: false,
      }
    },
    async commitTree(repo: string, tree: string, parents: readonly string[], message: string): Promise<string> {
      const result = await sh(repo, [
        "commit-tree",
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-m",
        message,
      ])
      if (result.code !== 0) throw new Error(result.stderr || "commit-tree failed")
      return result.stdout
    },
  }
}

const PIN_BASE = "0".repeat(39) + "1"
const PIN_A = "1".repeat(40)
const PIN_B = "2".repeat(40)

/**
 * The base commit already RECORDS every gitlink the wrapper will move. Discovered by
 * characterization: `update-index --cacheinfo <mode>,<sha>,<path>` (the comma form the
 * wrapper uses) refuses to ADD a path that is not in the index — "missing --add option?",
 * exit 128 — so the wrapper's contract is UPDATE-only. That matches production, where
 * added and deleted gitlinks are refused before composition ever runs.
 */
async function repository(paths: readonly string[] = ["dep"]): Promise<{ repo: string; parent: string }> {
  const repo = await mkdtemp(join(tmpdir(), "yrd-gitlink-wrapper-"))
  roots.push(repo)
  await sh(repo, ["init", "-q", "-b", "main"])
  await writeFile(join(repo, "README.md"), "base\n")
  await sh(repo, ["add", "README.md"])
  for (const path of paths) {
    await sh(repo, ["update-index", "--add", "--cacheinfo", `160000,${PIN_BASE},${path}`])
  }
  await sh(repo, ["commit", "-qm", "base"])
  const parent = (await sh(repo, ["rev-parse", "HEAD"])).stdout
  return { repo, parent }
}

describe("synthesizeGitlinkWrapper — the shaset-commit writer's contract as of the (b) build's start", () => {
  it("writes a commit whose diff is exactly the gitlink updates, nothing else", async () => {
    const { repo, parent } = await repository()
    const result = await synthesizeGitlinkWrapper(gitAdapter(), repo, parent, [{ path: "dep", sha: PIN_A }], "wrapper")

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n")).toEqual(["dep"])
    const entry = await sh(repo, ["ls-tree", result.output.commit, "--", "dep"])
    expect(entry.stdout).toContain(`160000 commit ${PIN_A}`)
  })

  it("with a provisioner, one gitlink plus exactly bun.lock is the whole diff", async () => {
    const { repo, parent } = await repository()
    const provisioned: string[] = []
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [{ path: "dep", sha: PIN_A }],
      "wrapper",
      async ({ provisionalCandidateSha }) => {
        provisioned.push(provisionalCandidateSha)
        await writeFile(join(repo, "bun.lock"), "regenerated\n")
        return { generatedPaths: ["bun.lock"] }
      },
    )

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    // The provisioner saw a real provisional commit, not the parent.
    expect(provisioned).toHaveLength(1)
    expect(provisioned[0]).not.toBe(parent)
    const changed = await sh(repo, ["diff", "--name-only", parent, result.output.commit])
    expect(changed.stdout.split("\n").toSorted()).toEqual(["bun.lock", "dep"])
  })

  /**
   * THE (b) FLIP TARGET. The provisioner leg refuses more than one gitlink update today, so
   * composed multi-submodule candidates get NO lock regeneration — the gap the provisioner
   * lift closes. When the lift lands, this refusal becomes support, and this test flips in
   * the same commit; risk 1 in b-derivation-sites says lift FIRST, then widen.
   */
  it("refuses a provisioner over more than one gitlink update — today's single-update contract", async () => {
    const { repo, parent } = await repository(["dep-a", "dep-b"])
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [
        { path: "dep-a", sha: PIN_A },
        { path: "dep-b", sha: PIN_B },
      ],
      "wrapper",
      async () => ({ generatedPaths: [] }),
    )

    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.error.code).toBe("wrapper-mismatch")
    expect(result.error.message).toContain("expected one gitlink update")
  })

  it("refuses a provisioner that generates anything but bun.lock", async () => {
    const { repo, parent } = await repository()
    const result = await synthesizeGitlinkWrapper(
      gitAdapter(),
      repo,
      parent,
      [{ path: "dep", sha: PIN_A }],
      "wrapper",
      async () => {
        await writeFile(join(repo, "package.json"), "{}\n")
        return { generatedPaths: ["package.json"] }
      },
    )

    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.error.code).toBe("wrapper-mismatch")
    expect(result.error.message).toContain("allowed [bun.lock]")
  })

  it("returns the parent untouched when there is nothing to stage — the nothing-new shape", async () => {
    const { repo, parent } = await repository()
    const result = await synthesizeGitlinkWrapper(gitAdapter(), repo, parent, [], "wrapper")

    expect(result.status).toBe("passed")
    if (result.status !== "passed") throw new Error("unreachable")
    expect(result.output.commit).toBe(parent)
  })
})
